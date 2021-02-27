# Jabzone Notifier

## Function for notifying about vaccine availability

This is the notifier tool for https://github.com/pettazz/findvax-scraper and https://github.com/pettazz/findvax-site

### What?

This is meant to be used as a single Lambda function which both handles API Gateway PUT requests to register notification requests (from the site), and triggered runs from the scraper functions to send notifications to those requesters if availability is found.

Notification requests are stored in DynamoDB as simple objects:

````
{
  location: String, UUID of the location to notify about (PK),
  isSent: Number, 0 for not yet sent, 1 for sent (currently not used),
  sms: String, phone number to which we send notification SMS (format: "5555555555", "+1" country code is prepended in the function)
}
````

To notify, it reads the availability.json from S3, collects any locations with found availability, then collects all the available locations per SMS number saved in the DB in requests to concatenate them into a single message per number. So we send *only one* message per number that looks like 

> Findvax.us found available slots:
> 
> Eastfield Mall: https://curative.com/sites/24182#9/
> Fenway Park: https://www.maimmunizations.org/clinic/search?commit=Search&q%5Bvenue_search_name_or_venue_name_i_cont%5D=fenway&search_radius=All
> Gillette Stadium: https://www.maimmunizations.org/clinic/search?commit=Search&q%5Bvenue_search_name_or_venue_name_i_cont%5D=gillette&search_radius=All
>
> We'll stop notifying you for these locations now. Re-subscribe on the site if needed.

Once we successfully send notifications, we delete all the matching items.

It doesn't run locally because I didn't put any work into a demo setup, oops.

### TODO

- Link shortener: either find an API or build our own, or (most likely) just edit locations.json so `linkUrl` is always a shortlink
- Handle states: scraper should pass along which state it just scraped, so notifier can use that to pick the correct availability.json
- Handle language: site should include `lang` code in the payload, which we can use to select a template for the SMS string
- Error handling: definitely a few cases where promises don't get resolved and we log nothing, need to clean up