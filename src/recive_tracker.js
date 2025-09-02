const express = require('express');
const router = express.Router();
const path = require('path');
const { validate: uuidValidate } = require('uuid');
const { queryTrackerByCustomURL, queryTrackerByUuid, PhoneNumberForTracker, MessageForTracker, UnicodeForTracker, createTracker, updateTracker } = require('./functions');
require('dotenv').config();

// Endpoint principal - serve a página de loading instantaneamente
router.get('/:id', async (req, res) => {
    try {
        // Serve a página de loading imediatamente
        const loadingPath = path.join(__dirname, '..', 'public', 'loading.html');
        res.sendFile(loadingPath);
    } catch (error) {
        console.error('Erro ao servir página de loading:', error);
        res.status(500).json({ message: 'Erro interno do servidor' });
    }
});

// Endpoint para processamento em background
router.get('/:id/process', async (req, res) => {
    try {
        let start_time = Date.now();
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
        
        let message_complete = message.charAt(0) + unicode + message.slice(1);

        // Primeiro atualiza o tracker
        await updateTracker(create_tracker.id, phone_number, message, message_complete);

        // Retorna a URL de redirecionamento como JSON
        let redirectUrl;
        if (userAgent.includes('facebook')) {
            redirectUrl = 'https://www.audracs.com.br';
        } else {
            redirectUrl = `https://wa.me/${phone_number}?text=${encodeURIComponent(message_complete)}`;
        }

        let end_time = Date.now();
        let duration = end_time - start_time;
        console.log(`[x] [TRACKER CLIENT GET DURATION] [${req.params.id}] [${duration}ms]`);    

        return res.json({ 
            success: true, 
            redirect: redirectUrl,
            duration: duration 
        });

    } catch (error) {
        console.error('Erro na consulta:', error);
        return res.status(500).json({ message: error.message || 'Erro ao consultar registro' });
    }
});

module.exports = router;    
