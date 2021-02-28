const secrets = require('./secrets.js');
const AWS = require('aws-sdk');

const msgTemplate = {
  en: {
    start: 'Findvax.us found available slots:\n\n',
    end: '\n\nWe\'ll stop notifying you for these locations now. Re-subscribe on the site if needed.'
  }
};

const handleAPIRequest = (event, successHandler, failureHandler) => {
  const db = new AWS.DynamoDB.DocumentClient({apiVersion: '2012-08-10'});

  const validateUUID = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/;
  const requiredFields = ['location', 'sms', 'lang'];
  let body;
  
  if(!event || !event.body || !event.body.trim().length > 0){
    throw 'Missing request body!';
  }

  body = JSON.parse(event.body.trim());
  console.log('Parsed request body: ', JSON.stringify(body));

  // i know apigw validates the request body against a jsonschema, 
  // but it's not like this is horribly expensive and it makes me feel better okay
  requiredFields.forEach((field) => {
    if(!(Object.keys(body).includes(field) && body[field].length > 0)){
      throw `Missing or incorrect type for required field \`${field}\` in body!`;
    }
  })

  const location = body.location,
        lang = body.lang,
        sms = '+1' + body.sms.replace(/\D/g, '');

  if(!validateUUID.test(location)){
    throw 'Invalid location uuid!';
  }
  if(!sms.length === 12){
    throw 'Invalid US phone number!';
  }
  if(!typeof lang === "string" && !lang.length == 2){
    throw 'Invalid language id (must be a two char string without localization like "en" or "fr")!';
  }

  let params = {
    TableName: 'notify',
    Item: {
      location: location,
      isSent: 0,
      sms: sms,
      lang: lang
    }
  };

  db.put(params, (err, data) => {
    if(err){
      console.error('Unable to add notifcation db item.');
      failureHandler(err);
    }else{
      console.log('Added notification db item:', JSON.stringify(data));
      successHandler();
    }
  });

}

const getAvailabilityData = (event) => {
  const s3 = new AWS.S3({apiVersion: '2006-03-01'});

  const availabilityParams = {
    Bucket: 'findvax-data',
    Key: 'MA/availability.json' // TODO: states lol:
    // get availability.json path from the event, passed in from scrape
  },
        locationsParams = {
    Bucket: 'findvax-data',
    Key: 'MA/locations.json' // TODO: states lol
  };

  let loadedData = {},
      locationAvailability = [];

  return Promise.all([
    s3.getObject(availabilityParams).promise().then(data => {
      loadedData.availability = JSON.parse(data.Body.toString('utf-8'));
    }),
    s3.getObject(locationsParams).promise().then(data => {
      loadedData.locations = JSON.parse(data.Body.toString('utf-8'));
    })
  ]).then(() => {
    if((loadedData.locations && loadedData.locations.length > 0) ||
       (loadedData.availability && loadedData.availability.length > 0)){
        
        locationAvailability = loadedData.locations.map((location) => {
          let locationDetail = null;
          const foundAvailability = loadedData.availability.find(avail => avail.location && avail.location === location.uuid) || null;
        
          if (foundAvailability &&
              foundAvailability.times &&
              foundAvailability.times.length > 0){

            let timeslots = foundAvailability.times.reduce((acc, avail) => {
              if(avail.slots === null){
                // since we don't have a specific count for this time slot, just use
                // an arbitrary large number to ensure it's above any threshold
                return acc + 100; 
              }

              return acc + avail.slots;
            });

            // if we dont have more slots than this location's threshold.
            // prevents sending an sms for 1 slot that was gone 45 seconds
            // before this script even got triggered.
            if(!location.notificationThreshold || timeslots > location.notificationThreshold){
              locationDetail = {
                uuid: location.uuid,
                name: location.name,
                url: location.linkUrl
              };  
            }
          }

          return locationDetail;
        });
    }

    return locationAvailability;
  });
}

const sendNotifications = (locations, successHandler, failureHandler) => {
  const db = new AWS.DynamoDB.DocumentClient({apiVersion: '2012-08-10'}),
        pinpoint = new AWS.Pinpoint({apiVersion: '2016-12-01'});

  let notisToSend = {};

  let q = [];
  locations.forEach(location => {
    if(location){

      const params = {
        TableName: 'notify',
        ProjectionExpression: '#loc, #st, sms, lang',
        KeyConditionExpression: '#loc = :id and #st = :no',
        ExpressionAttributeNames: {
          '#loc': 'location',
          '#st': 'isSent'
        },
        ExpressionAttributeValues: {
          ':id': location.uuid,
          ':no': 0
        }
      };

      const queryPromise = db.query(params).promise().then(data => {
        data.Items.forEach(noti => {
          if(!Object.keys(notisToSend).includes(noti.sms)){
            notisToSend[noti.sms] = {lang: noti.lang, locations: []};
          }
          notisToSend[noti.sms].locations.push({name: location.name, link: location.url});
        }); 
      }).catch(err => {
        failureHandler(err);
      });
      
      q.push(queryPromise);
    }
  });

  return Promise.all(q).then(() => {
    let smsQ = [];

    for(const [sms, details] of Object.entries(notisToSend)){
      let lang = details.lang || 'en';
      if(!Object.keys(msgTemplate).includes(lang)){
        console.log(`Unrecognized lang id: '${lang}', defaulting to 'en'`);
        lang = 'en';
      }

      let msg = details.locations.reduce((msg, next) => {
        return msg + `${next.name}: ${next.link}\n`;
      }, msgTemplate[lang].start);
      msg += msgTemplate[lang].end;
    
      const msgParams = {
        ApplicationId: secrets.applicationId,
        MessageRequest: {
          Addresses: {
            [sms]: {
              ChannelType: 'SMS'
            }
          },
          MessageConfiguration: {
            SMSMessage: {
              Body: msg,
              MessageType: 'TRANSACTIONAL',
              OriginationNumber: secrets.originationNumber
            }
          }
        }
      };
      smsQ.push(pinpoint.sendMessages(msgParams).promise());

      return Promise.all(smsQ).then(() => {
        let deleteQ = [];

        locations.forEach(location => {
          if(location){

            const params = {
              TableName: 'notify',
              Key:{
                  'location': location.uuid,
                  'isSent': 0
              }
            };

            const deletePromise = db.delete(params).promise();
            deleteQ.push(deletePromise);

            return Promise.all(deleteQ).then(() => {

              successHandler();

            }).catch(err => {
              failureHandler(err);
            });
          }
        });

      }).catch(err => {
        failureHandler(err);
      });
    }

  }).catch(err => {
    failureHandler(err);
  });
}

exports.handler = (event, context, callback) => {
  // declare within the scope of the handler so we can pass them around for reuse
  const rb = callback;
  const win = () => {
    rb(null, {
      isBase64Encoded: false,
      statusCode: 200,
      headers: {},
      multiValueHeaders: {},
      body: ""
    });
  }
  const die = (error) => {
    let statusCode = 500,
        errorBody = `{ "message": "Something went wrong! Unable to get error details."}`;

    console.error(JSON.stringify(error));
    if(typeof error === "string"){

      if(error.startsWith('Missing ') || error.startsWith('Invalid ')){
        statusCode = 400;
      }

      errorBody = `{ "message": "${error}"}`;
    }else{
      // 5xx errors
      if(error.code){
        errorBody = `{ "message": "Function execution error: ${error.code}: ${error.message}"}`;
      }else if(error.message){
        errorBody = `{ "message": "Function execution error: ${error.message}"}`;
      }
    }

    rb(null, {
      isBase64Encoded: false,
      statusCode: statusCode,
      headers: {},
      multiValueHeaders: {},
      body: errorBody
    });
  }

  // detect where this came from and how to handle it
  try{

    if(event.httpMethod){
      // this was triggered by API Gateway
      handleAPIRequest(event, win, die);
    }else if(event.requestPayload){
      // this was triggered by the previous lambda
      getAvailabilityData(event).then(data => sendNotifications(data, win, die));
    }else{
      throw 'Unknown trigger! I dunno how to handle this!';
    }

  }catch(error){
    die(error);
  }
};
