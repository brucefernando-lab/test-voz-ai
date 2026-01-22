import fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import WebSocket from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const app = fastify();
app.register(fastifyWs);

const { OPENAI_API_KEY, N8N_WEBHOOK_URL, N8N_TRACKING_WEBHOOK_URL } = process.env;
const VOICE_MODEL = 'gpt-4o-mini-realtime-preview';
const SYSTEM_MESSAGE = 'Eres Sofía. Responde corto. PUEDES SER INTERRUMPIDA: si el usuario habla, cállate inmediatamente. Si te dan un número de guía, usa la herramienta consultar_guia.';

const TOOLS = [{
    type: "function",
    name: "consultar_guia",
    description: "Consulta el estatus de un paquete",
    parameters: { type: "object", properties: { numero_guia: { type: "string" } }, required: ["numero_guia"] }
}];

app.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('🚀 Twilio conectado');
        
        let streamSid = "";
        const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${VOICE_MODEL}`, {
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
        });

        openAiWs.on('open', () => {
            console.log('📡 Conectado a OpenAI');
            openAiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                    instructions: SYSTEM_MESSAGE,
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    tools: TOOLS,
                    tool_choice: "auto",
                    turn_detection: { type: 'server_vad', threshold: 0.5 }
                }
            }));
        });

        openAiWs.on('message', async (data) => {
            const response = JSON.parse(data);

            if (response.type === 'input_audio_buffer.speech_started') {
                console.log('🎤 Usuario hablando -> IA se calla');
                openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
                connection.send(JSON.stringify({ event: 'clear', streamSid }));
            }

            if (response.type === 'response.audio.delta' && response.delta) {
                connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: response.delta } }));
            }

            if (response.type === 'response.done' && response.response?.output) {
                for (const output of response.response.output) {
                    if (output.type === 'function_call' && output.name === 'consultar_guia') {
                        const { numero_guia } = JSON.parse(output.arguments);
                        console.log(`🔍 Consultando guía: ${numero_guia}`);
                        try {
                            const n8nResponse = await fetch(N8N_TRACKING_WEBHOOK_URL, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ numero_guia })
                            });
                            const result = await n8nResponse.json();
                            openAiWs.send(JSON.stringify({
                                type: 'conversation.item.create',
                                item: { type: 'function_call_output', call_id: output.call_id, output: JSON.stringify(result) }
                            }));
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        } catch (e) { console.error("Error n8n:", e.message); }
                    }
                }
            }
        });

        connection.on('message', (message) => {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`📞 Llamada en curso: ${msg.start.callSid}`);
            } else if (msg.event === 'media') {
                if (openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
                }
            }
        });

        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('⏹️ Twilio desconectado');
        });
        
        openAiWs.on('error', (e) => console.error("OpenAI Error:", e.message));
        connection.on('error', (e) => console.error("Twilio Connection Error:", e.message));
    });
});

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' }, () => console.log(`🚀 Sofía lista en puerto ${PORT}`));
