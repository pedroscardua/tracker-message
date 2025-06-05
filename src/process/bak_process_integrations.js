//////
                                        //////    Enviar evento de conversão
                                        //////
                                        if(queryTracker.rows[0].internal_source_id !== null && queryTracker.rows[0].internal_source_id !== undefined && queryTracker.rows[0].internal_source_id !== ''){
                                            const querySourceData = await client.query(
                                                `SELECT * FROM sources WHERE id = $1`,
                                                [queryTracker.rows[0].internal_source_id]
                                            );
                                            // Verifica se tem source
                                            if(querySourceData.rows[0].length !== 0){
                                                /////
                                                ///// Verifica qual sistema de source usar
                                                /////
                                                // PINTEREST ////////

                                                const queryGetPinterest = await client.query(
                                                    `SELECT * FROM sources WHERE id = $1`,
                                                    [queryTracker.rows[0].internal_source_id]
                                                );

                                                const parameters = queryGetPinterest.rows[0].paramters;
                                                const parametersMap = new Map(Object.entries(parameters));
                                                const pinterestToken = parametersMap.get('convertion_token');
                                                const adAccountId = parametersMap.get('ad_account_id');

                                                const event_id = `track_${updateTracker.rows[0].id}_user_${userId}_time_${timestampINT64}`;
                                                const ip_user = updateTracker.rows[0].client_ip_address;
                                                const userAgent = updateTracker.rows[0].client_user_agent;
                                                const product_id = queryTracker.rows[0].product_id;
                                                const toShaListIds = userIdentifierListIds.map(id => sha256(id));
                                                const list_user_ids = toShaListIds;

                                                if(querySourceData.rows[0].type === 'pinterest'){
                                                    const data = {
                                                        "data": [
                                                          {
                                                            "action_source": "offline",
                                                            "event_id": event_id,
                                                            "event_name": "lead",
                                                            "event_time": timestampINT64,
                                                            "user_data": {
                                                              "client_ip_address": ip_user,
                                                              "client_user_agent": userAgent,
                                                              "external_id": list_user_ids,
                                                              "ph": [sha256(message.data.key.remoteJid.split('@')[0])],
                                                              "em": [sha256(message.data.key.remoteJid.split('@')[0])]
                                                            },
                                                            "custom_data": {
                                                              "content_ids": [product_id]
                                                            }
                                                          }
                                                        ]
                                                      };
                                  
                                                      try {
                                                        await axios.post(
                                                          `https://api.pinterest.com/v5/ad_accounts/${adAccountId}/events?test=true`,
                                                          data,
                                                          {
                                                            headers: {
                                                              'Authorization': `Bearer ${pinterestToken}`,
                                                              'Content-Type': 'application/json'
                                                            }
                                                          }
                                                        );
                                                      } catch (error) {
                                                        console.error('Erro ao enviar evento para o Pinterest:', error);
                                                      }

                                                }

                                            } 

                                        }

                                        //////
                                        //////    Enviar evento de CRM cadastro/update
                                        //////
                                        // Verificar qual sistema integrado a esse router_tracker.
                                        const querySystemIntegrated = await client.query(
                                            `SELECT * FROM sys_integrations WHERE id = $1`,
                                            [queryTracker.rows[0].sys_integration_id]
                                        );
                                        // verifica se tem um sistema conectado a essa router
                                        if (querySystemIntegrated.rows.length !== 0) {
                                            // console.log(`[x] Sistema integrado encontrado:`, querySystemIntegrated.rows);
                                            //////////
                                            //////////      Determina qual estrutura de sistema deve enviar a conversão
                                            //////////
                                            if (querySystemIntegrated.rows[0].type === 'clint') {
                                                // console.log(`[x] Sistema integrado é o Clint:`, querySystemIntegrated.rows);
                                                const webhookUrl = 'https://functions-api.clint.digital/endpoints/integration/webhook/333525b4-0ed4-49ef-9805-fd573f1c5114';
                                                const payload = {
                                                    contact_tags: "tracker_lead, dadads, dwdsadw",
                                                    contact_name: message.data.pushName.replaceAll(emojis, ''),
                                                    contact_phone: message.data.key.remoteJid.split('@')[0],
                                                    contact_utm_campaign: updateTracker.rows[0].utm_campaign,
                                                    contact_utm_content: updateTracker.rows[0].utm_content,
                                                    contact_utm_source: updateTracker.rows[0].utm_source,
                                                    contact_utm_medium: updateTracker.rows[0].utm_medium
                                                };
                                                await axios.post(webhookUrl, payload);
                                                // response from webhook
                                                const response = await axios.post(webhookUrl, payload);
                                                // console.log(`[x] Resposta do webhook:`, response.data);
                                            }
                                        }