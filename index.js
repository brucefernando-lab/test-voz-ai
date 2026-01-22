import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastify from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';

dotenv.config();

// Recuperamos las variables que pusiste en Railway
const { 
    OPENAI_API_KEY, 
    N8N_WEBHOOK_URL, 
    N8N_TRACKING_WEBHOOK_URL 
} = process.env;

const app = fastify();
app.register(fastifyFormbody);
app.register(fastifyWs);

// Configuración del Sistema
const SYSTEM_MESSAGE = 'Eres Sofía, una asistente amable. PUEDES SER INTERRUMPIDA. Si el usuario habla mientras tú hablas, cállate de inmediato. Si te dan un número de guía, usa la herramienta "consultar_guia" para darles el estatus real.';
const VOICE_MODEL = 'gpt-4o-mini-realtime-preview';

// Definición de la Herramienta de Rastreo
const TOOLS = [
  {
    type: "function",
    name: "consultar_guia",
    description: "Consulta el estatus de un paquete en la base de datos",
    parameters: {
      type: "object",
      properties: {
        numero_guia: { type: "string", description: "El número de rastreo que dio el cliente" }
      },
      required: ["numero_guia"]
    }
  }
];

app.all('/media-stream', { websocket: true }, (connection, req) => {
    let streamSid = "";
    let callSid = "";
    let startTime = Date.now();

    // Conexión con OpenAI Realtime
    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${VOICE_MODEL}`, {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    // Configuración de la sesión al abrir
    openAiWs.on('open', () => {
        const sessionUpdate = {
            type: 'session.update',
            session: {
                instructions: SYSTEM_MESSAGE,
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                tools: TOOLS,
                tool_choice: "auto",
                turn_detection: { 
                    type: 'server_vad',
                    threshold: 0.5, // Sensibilidad de detección de voz
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500
                }
            }
        };
        openAiWs.send(JSON.stringify(sessionUpdate));
    });

    openAiWs.on('message', async (data) => {
        const response = JSON.parse(data);

        // --- LÓGICA DE INTERRUPCIÓN (Barge-in) ---
        if (response.type === 'input_audio_buffer.speech_started') {
            console.log("Interrupción detectada. Cancelando audio...");
            openAiWs.send(JSON.stringify({ type: 'response.cancel' })); // Para a la IA
            connection.send(JSON.stringify({ event: 'clear', streamSid })); // Borra audio en Twilio
        }

        // --- MANEJO DE HERRAMIENTAS (RASTREO DE GUÍAS) ---
        if (response.type === 'response.done' && response.response.output) {
            for (const output of response.response.output) {
                if (output.type === 'function_call' && output.name === 'consultar_guia') {
                    const { numero_guia } = JSON.parse(output.arguments);
                    console.log(`Buscando guía en n8n: ${numero_guia}`);
                    
                    try {
                        const n8nRes = await fetch(N8N_TRACKING_WEBHOOK_URL, {
                            method: 'POST',
                            body: JSON.stringify({ numero_guia, callSid }),
                            headers: { 'Content-Type': 'application/json' }
                        });
                        const info = await n8nRes.json();
                        
                        // Enviamos la respuesta de n8n de vuelta a la IA
                        openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: output.call_id,
                                output: JSON.stringify(info)
                            }
                        }));
                        openAiWs.send(JSON.stringify({ type: 'response.create' }));
                    } catch (error) {
                        console.error("Error consultando n8n:", error);
                    }
                }
            }
        }

        // Enviar audio generado por la IA hacia Twilio
        if (response.type === 'response.audio.delta' && response.delta) {
            const audioDelta = {
                event: 'media',
                streamSid: streamSid,
                media: { payload: response.delta }
            };
            connection.send(JSON.stringify(audioDelta));
        }
    });

    // Recibir audio y eventos desde Twilio
    connection.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            console.log(`Llamada iniciada: ${callSid}`);
        } else if (msg.event === 'media') {
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: msg.media.payload
                }));
            }
        }
    });

    // Al cerrar la llamada enviamos el reporte final
    connection.on('close', async () => {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        
        const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
        console.log(`Llamada terminada. Duración: ${durationSeconds}s`);

        if (N8N_WEBHOOK_URL) {
            try {
                await fetch(N8N_WEBHOOK_URL, {
                    method: 'POST',
                    body: JSON.stringify({
                        event: 'call_ended',
                        callSid: callSid,
                        duration: durationSeconds,
                        timestamp: new Date().toISOString()
                    }),
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (e) {
                console.log("Error enviando reporte a n8n:", e.message);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' }, () => {
    console.log(`Servidor de Sofía escuchando en puerto ${PORT}`);
});
