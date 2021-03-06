var Mailgun = require('mailgun-js');
var fs = require('fs');


module.exports = {

    getInstance: function() {
        var settings = sails.config.mailgun;

        var mailgun = new Mailgun({
            apiKey: settings.apiKey,
            domain: settings.domain
        });

        return mailgun;
    },

    subscribe: function(email, subscribed) {
        var settings = sails.config.mailgun;

        var mailgun = MailService.getInstance();
        var list = mailgun.lists(settings.mailingList + '@' + settings.domain);

        list.members().create({
            subscribed: true,
            address: email
        }, function(err, resp) {
            if (err) {
                sails.log.warn(err);
                list.members(email).update({ subscribed: subscribed }, function(err, resp) {
                    if (err) {
                        sails.log.warn(err);
                    }
                    else {
                        sails.log.info(resp.message);
                    }
                });
            }
            else {
                sails.log.info(resp.message);
            }
        });
    },

    send: function(subject, text, from, to, html) {
        var mailgun = MailService.getInstance();
        var params = {
            from: from,
            to: to,
            subject: subject,
            text: text,
            html: html,
            'recipient-variables': '{}'
        };

        return mailgun.messages().send(params)
        .then(function(resp) {
            sails.log.info(resp.message);
        }, function(err) {
            sails.log.info(err);
        });
    },

};
