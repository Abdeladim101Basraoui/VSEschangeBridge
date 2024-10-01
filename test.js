const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// MQTT Broker configuration
const brokerUrl = 'mqtt://192.168.10.122:8888';
const mqttOptions = {
    username: 'aba',
    password: '2024',
};

// Create MQTT client
const mqttClient = mqtt.connect(brokerUrl, mqttOptions);

// Express setup to create an HTTP server
const app = express();
const server = http.createServer(app);

// Enable CORS for all origins (you can restrict it later if needed)
app.use(cors());

// Socket.IO setup
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000",  // Allow requests from your React app's domain
        methods: ["GET", "POST"],  // Specify allowed HTTP methods
        allowedHeaders: ["content-type"],  // Specify allowed headers
        credentials: true,
    }
});

// Socket.IO connection event
io.on('connection', (socket) => {
    console.log('A WebSocket client connected');

    // Send a welcome message to the client
    socket.emit('message', 'Welcome to the MQTT-Socket.IO service');

    // Handle StartMonitor messages from the client
    socket.on('StartMonitor', (data) => {
        const { monitor_id, patient_ipp, patient_name, event } = JSON.parse(data);
        console.log(`Start monitoring device ${monitor_id} for patient ${patient_ipp} (${patient_name}) event ${event}`);

        // Publish the configuration message to the MQTT broker
        mqttClient.publish(`mediot/${monitor_id}/configuration`, data, (err) => {
            if (err) {
                console.error('Failed to publish configuration to MQTT:', err);
            } else {
                console.log(`Published to mediot/${monitor_id}/configuration`);
            }
        });

        // Subscribe to the monitor_id's data topic if not already subscribed
        mqttClient.subscribe(`mediot/${monitor_id}/data`, (err) => {
            if (err) {
                console.error(`Failed to subscribe to mediot/${monitor_id}/data`, err);
            } else {
                console.log(`Subscribed to mediot/${monitor_id}/data`);
            }
        });
    });

    // Handle WebSocket disconnect
    socket.on('disconnect', () => {
        console.log('A WebSocket client disconnected');
    });
});

// MQTT connection event
mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker');
});

// MQTT message event: Handle incoming messages and broadcast to WebSocket clients
mqttClient.on('message', (topic, message) => {
    const messageString = message.toString();
    console.log(`Received message from MQTT topic: ${topic}`, messageString);

    const { Timestamp, TEMP, SPO2, NIBP, PR, HR } = JSON.parse(messageString);
    // Check if the topic matches your dynamic monitor topic
    if (topic.startsWith('mediot/') && topic.endsWith('/data')) {

        // Emit the message to all connected WebSocket clients
        io.emit('MonitorVitalData', {
            Timestamp, TEMP, SPO2, NIBP, PR, HR
        });
    }
});

// Handle errors in MQTT connection
mqttClient.on('error', (err) => {
    console.error('MQTT connection error:', err);
});

// Start the server on port 5500
server.listen(5500, () => {
    console.log('Server is listening on port 5500');
});
