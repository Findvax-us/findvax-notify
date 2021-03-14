const secrets = require('./secrets.js');
const AWS = require('aws-sdk');

const responseHeaders = {
  'Access-Control-Allow-Headers' : 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS,PUT'
};

// special function for sending out specific notifications
// not to be used with any automation


// zone for config

const msgTemplate = {
  en: {
    start: 'MA now uses a preregistration tool for the 7 mass vaccination locations. Findvax.us may no longer be able to see availability at these locations you requested:\n\n',
    end: '\n\nPlease register with the state tool: https://www.mass.gov/info-details/preregister-for-a-covid-19-vaccine-appointment'
  }
};

const UUIDsToNotifyAbout = [
  '20f0ede4-3dd3-4ba7-81c6-a0faae61b06a',
  '8001647e-ecd5-497f-b846-42f68d334ae8',
  'c62ce219-a538-4d34-982c-0a8fddfb573f',
  '61663d71-7cbb-4d18-9c33-bc1dcfcd1fbb',
  '5e674bef-542d-497b-bb8e-06a5534b3e81',
  '3225f157-1334-498c-b14b-827bcf1b1c7f',
  'a37f7af3-87b3-4be8-8008-f194d721b1a6'
];

// end config


const getAvailabilityData = () => {
  const s3 = new AWS.S3({apiVersion: '2006-03-01'});

  const locationsParams = {
    Bucket: 'findvax-data',
    Key: 'MA/locations.json' // TODO: states lol
  };

  return s3.getObject(locationsParams).promise().then(data => {
    let locations = JSON.parse(data.Body.toString('utf-8'));

    return locations.filter((location) => UUIDsToNotifyAbout.includes(location.uuid));

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
        return msg + `${next.name}\n`;
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
      // smsQ.push(pinpoint.sendMessages(msgParams).promise());
      console.log(msgParams);
    }
    return Promise.all(smsQ).then(done => {
      successHandler();
    }).catch(err => {
      failureHandler(err);
    });

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
      headers: responseHeaders,
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
      headers: responseHeaders,
      multiValueHeaders: {},
      body: errorBody
    });
  }

  try{

    getAvailabilityData().then(data => sendNotifications(data, win, die));

  }catch(error){
    die(error);
  }
};
