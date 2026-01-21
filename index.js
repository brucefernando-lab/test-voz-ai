const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');

// Configuración
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('ERROR: Falta la OPENAI_API_KEY en las variables de entorno');
  process.exit(1);
}

// Crear servidor HTTP básico para que Railway sepa que estamos vivos
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Servidor de Voz AI Activo');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Nueva llamada entrante de Telnyx');

  // Conectar con OpenAI Realtime API (Modelo Mini)
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17', {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let streamId = null;

  // Cuando OpenAI se conecta
  openaiWs.on('open', () => {
    console.log('Conectado a OpenAI');
    
    // Configurar el Asistente (Instrucciones iniciales)
    const sessionUpdate = {
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' }, // Detectar silencio automáticamente
        input_audio_format: 'g711_ulaw',        // Formato de Telnyx
        output_audio_format: 'g711_ulaw',
        voice: 'alloy',                         // Voz (alloy, ash, coral)
        instructions: 'Eres un asistente útil y amable de un centro de llamadas. Tu nombre es Sofia. Responde brevemente y en español. Saluda al cliente.',
        modalities: ["text", "audio"],
        temperature: 0.6,
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
  });

  // Mensajes desde Telnyx (Audio del cliente)
  ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.event === 'start') {
      streamId = msg.start.stream_id;
      console.log(`Stream iniciado: ${streamId}`);
    } else if (msg.event === 'media') {
      // Enviar audio a OpenAI
      if (openaiWs.readyState === WebSocket.OPEN) {
        const audioAppend = {
          type: 'input_audio_buffer.append',
          audio: msg.media.payload,
        };
        openaiWs.send(JSON.stringify(audioAppend));
      }
    } else if (msg.event === 'stop') {
      console.log('Llamada finalizada por Telnyx');
      openaiWs.close();
    }
  });

  // Mensajes desde OpenAI (Audio de la IA)
  openaiWs.on('message', (data) => {
    const response = JSON.parse(data);

    if (response.type === 'session.updated') {
      console.log('Sesión configurada correctamente');
    }

    // Cuando OpenAI nos manda audio de respuesta
    if (response.type === 'response.audio.delta' && response.delta) {
      const audioPayload = response.delta;
      // Enviar audio a Telnyx
      if (ws.readyState === WebSocket.OPEN) {
        const mediaMessage = {
          event: 'media',
          media: {
            payload: audioPayload,
          },
        };
        ws.send(JSON.stringify(mediaMessage));
      }
    }
  });

  // Manejo de cierres y errores
  ws.on('close', () => {
    console.log('Cliente Telnyx desconectado');
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on('close', () => console.log('OpenAI desconectado'));
  openaiWs.on('error', (error) => console.error('Error OpenAI:', error));
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});