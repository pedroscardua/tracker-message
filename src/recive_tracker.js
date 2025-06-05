const express = require('express');
const router = express.Router();
const { validate: uuidValidate } = require('uuid');
const { queryTrackerByCustomURL, queryTrackerByUuid, PhoneNumberForTracker, MessageForTracker, UnicodeForTracker, createTracker, updateTracker } = require('./functions');
require('dotenv').config();

router.get('/:id', async (req, res) => {
    try {
        let router;
        router = [];
        // verifique se id é uuid
        if (!uuidValidate(req.params.id)) {
            // call function query by id
            router = await queryTrackerByCustomURL(req.params.id);
        } else {
            // call function query by uuid
            router = await queryTrackerByUuid(req.params.id);
        }
        if (router.length === 0) {
            return res.status(404).json({ message: 'Link expirado ou não encontrado' });
        }

        const { 
            text, 
            business: businessId, 
            utm_campaign: utmCampaign, 
            utm_medium: utmMedium, 
            utm_source: utmSource, 
            utm_content: utmContent 
          } = req.query;

        const ip_user = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
        const userAgent = req.headers['user-agent'];
        
        let create_tracker;
        create_tracker = await createTracker(router.id, router.business_id, utmCampaign, utmMedium, utmSource, utmContent, ip_user, userAgent);

        let phone_number;
        phone_number = await PhoneNumberForTracker(router.phone_list, router.actual_phone, router.phone_type, router.id);

        let message;
        message = await MessageForTracker(router.message_list, router.actual_message, router.message_type, router.id);

        let unicode;
        unicode = await UnicodeForTracker(create_tracker.id);
        
        let message_complete = unicode + message;

        const redirect_url = `https://wa.me/${phone_number}?text=${message_complete}`;
        res.redirect(redirect_url);

        let update_tracker;
        update_tracker = await updateTracker(create_tracker.id, phone_number, message,message_complete );

    } catch (error) {
        console.error('Erro na consulta:', error);
        return res.status(500).json({ message: error.message || 'Erro ao consultar registro' });
    }
});

module.exports = router;    
