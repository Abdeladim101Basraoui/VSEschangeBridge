const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
// MQTT Broker configuration
const brokerUrl = 'mqtt://192.168.10.122:8888';
const mqttOptions = {
    username: 'aba',
    password: '2024',
};

// File to store active subscriptions
const subscriptionsFile = path.join(__dirname, 'subscriptions.json');

// Load active subscriptions from file
let activeSubscriptions = {};
if (fs.existsSync(subscriptionsFile)) {
    try {
        const fileContent = fs.readFileSync(subscriptionsFile, 'utf8');
        if (fileContent) {
            activeSubscriptions = JSON.parse(fileContent);
        }
    } catch (error) {
        console.error('Failed to parse subscriptions file:', error);
    }
}

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

let bufferedMessages = {};
let unsentMessages = {};

// Socket.IO connection event
io.on('connection', (socket) => {
    console.log('A WebSocket client connected');

    // Send a welcome message to the client
    socket.emit('message', 'Welcome to the MQTT-Socket.IO service');

    // Handle StartMonitor messages from the client
    socket.on('StartMonitor', (data) => {
        const { monitor_id, patient_ipp, patient_name, event } = JSON.parse(data);
        console.log(`Start monitoring device ${monitor_id} for patient ${patient_ipp} (${patient_name}) event ${event}`);
    
        if (event === 'stop') {
            // Unsubscribe from the monitor_id's data topic
            if (activeSubscriptions[monitor_id]) {
                mqttClient.unsubscribe(`mediot/${monitor_id}/data`, (err) => {
                    if (err) {
                        console.error(`Failed to unsubscribe from mediot/${monitor_id}/data`, err);
                    } else {
                        console.log(`Unsubscribed from mediot/${monitor_id}/data`);
                        activeSubscriptions[monitor_id].active = false;
                        activeSubscriptions[monitor_id].stopDate = new Date().toISOString();
                        saveSubscriptions();
                    }
                });
            }
            // return;
        }
    
        // Publish the configuration message to the MQTT broker
        mqttClient.publish(`mediot/${monitor_id}/configuration`, data, (err) => {
            if (err) {
                console.error('Failed to publish configuration to MQTT:', err);
            } else {
                console.log(`Published to mediot/${monitor_id}/configuration`);
            }
        });
    
        // Subscribe to the monitor_id's data topic if not already subscribed
        if (!activeSubscriptions[monitor_id] || !activeSubscriptions[monitor_id].active) {
            mqttClient.subscribe(`mediot/${monitor_id}/data`, (err) => {
                if (err) {
                    console.error(`Failed to subscribe to mediot/${monitor_id}/data`, err);
                } else {
                    console.log(`Subscribed to mediot/${monitor_id}/data`);
                    activeSubscriptions[monitor_id] = {
                        active: true,
                        startDate: new Date().toISOString(),
                        stopDate: null
                    };
                    saveSubscriptions();
                }
            });
        }
    
        // Send buffered messages to the client if any 
        if (bufferedMessages[monitor_id]) {
            const combinedData = {
                data: bufferedMessages[monitor_id].data,
                wave: bufferedMessages[monitor_id].wave
            };
            socket.emit('MonitorVitalData', JSON.stringify(combinedData));
        }

    });
    

    // Handle WebSocket disconnect
    socket.on('disconnect', () => {
        console.log('A WebSocket client disconnected');
    });

    // Handle acknowledgment from the client
    socket.on('ack', (data) => {
        const { monitor_id, messageId } = JSON.parse(data);
        if (unsentMessages[monitor_id]) {
            unsentMessages[monitor_id] = unsentMessages[monitor_id].filter(msg => msg.id !== messageId);
        }
    });

    // Handle reconnection
    socket.on('reconnect', () => {
        console.log('A WebSocket client reconnected');
        // Resend unsent messages
        Object.keys(unsentMessages).forEach(monitor_id => {
            const combinedData = {
                data: unsentMessages[monitor_id].data,
                wave: unsentMessages[monitor_id].wave
            };
            socket.emit('MonitorVitalData', JSON.stringify(combinedData));
        });
    });
});

// MQTT connection event
mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker');

    // Re-subscribe to previously active subscriptions
    Object.keys(activeSubscriptions).forEach((monitor_id) => {
        if (activeSubscriptions[monitor_id].active) {
            mqttClient.subscribe(`mediot/${monitor_id}/data`, (err) => {
                if (err) {
                    console.error(`Failed to re-subscribe to mediot/${monitor_id}/data`, err);
                } else {
                    console.log(`Re-subscribed to mediot/${monitor_id}/data`);
                }
            });
            mqttClient.subscribe(`mediot/${monitor_id}/wave`, (err) => {
                if (err) {
                    console.error(`Failed to re-subscribe to mediot/${monitor_id}/wave`, err);
                } else {
                    console.log(`Re-subscribed to mediot/${monitor_id}/wave`);
                }
            });
        }
    });

       // Always subscribe to dicom/data topic
    mqttClient.subscribe('dicom/data', (err) => {
        if (err) {
            console.error('Failed to subscribe to dicom/data', err);
        } else {
            console.log('Subscribed to dicom/data');
        }
    });
});

// MQTT message event: Handle incoming messages and broadcast to WebSocket clients
mqttClient.on('message', (topic, message) => {
    const messageString = message.toString();
    const topicMonitorId = topic.split('/')[1];

    // Initialize the data structure if it doesn't exist
    if (!bufferedMessages[topicMonitorId]) {
        bufferedMessages[topicMonitorId] = { data: [], wave: null };
    }

    if (!unsentMessages[topicMonitorId]) {
        unsentMessages[topicMonitorId] = { data: [], wave: null };
    }

    // Check if the topic matches your dynamic monitor data topic
    if (topic.startsWith('mediot/') && topic.endsWith('/data')) {
        console.log(`Received message from MQTT topic: ${topic}`, messageString);
        const { Timestamp, TEMP, SPO2, NIBP, PR, HR } = JSON.parse(messageString);
        const vitalData = { id: Date.now(), monitor_id: topicMonitorId, Timestamp, TEMP, SPO2, NIBP, PR, HR };

        // Buffer the message
        bufferedMessages[topicMonitorId].data.push(vitalData);
        unsentMessages[topicMonitorId].data.push(vitalData);
    }

    // Check if the topic matches your dynamic monitor wave topic
    if (topic.startsWith('mediot/') && topic.endsWith('/wave')) {
        const waveData = { id: Date.now(), monitor_id: topicMonitorId, image: message};
        console.log(`Received message from MQTT topic: ${topic}`, waveData);

        // Buffer the wave data
        bufferedMessages[topicMonitorId].wave = waveData;
        unsentMessages[topicMonitorId].wave = waveData;
    }


    // Check if the topic matches dicom/data
    if (topic === 'dicom/data') {
        console.log(`Received message from MQTT topic: ${topic}`, messageString);
    
        // Handle dicom/data message
        const dicomData = JSON.parse(messageString);
    
        // Extract patient information and path
        const { patientId, patientName, path } = dicomData;
    
        // Make a GET request to the DICOM image path with basic authentication
        const username = 'orthanc';
        const password = 'orthanc';
    
        const fetchDicomImage = async () => {
            try {
                // Make the GET request with basic auth
                const response = await axios.get(`http://192.168.10.122:8042/dicom/${path}`, {
                    auth: {
                        username: username,
                        password: password
                    },
                    responseType: 'arraybuffer' // Use arraybuffer for binary data
                });
    
                // Assuming the image is in the response data
                const dicomImage = response.data;
    
                // Create the object containing the full data
                const dicomImageData = {
                    patientId,
                    patientName,
                    path,
                    DicomImage: dicomImage // This will be binary image data
                };
    
                // Log or emit the image data as needed
                console.log('Dicom Image Data:', dicomImageData);
                
                // Emit the data (if using sockets)
                io.emit('DicomData', dicomImageData);
                
            } catch (error) {
                console.error('Error fetching DICOM image:', error);
            }
        };
        fetchDicomImage()
    }
    
    // Emit the combined data and wave to all connected WebSocket clients
    if (bufferedMessages[topicMonitorId].data.length > 0 && bufferedMessages[topicMonitorId].wave) {
        const combinedData = {
            data: bufferedMessages[topicMonitorId].data,
            wave: bufferedMessages[topicMonitorId].wave
        };

        console.log(`Sending Data from MQTT to:MonitorVitalData`, combinedData);

        io.emit('MonitorVitalData', JSON.stringify(combinedData));

        // Clear the buffered messages after sending
        bufferedMessages[topicMonitorId].data = [];
        bufferedMessages[topicMonitorId].wave = null;
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

// Save active subscriptions to file
function saveSubscriptions() {
    fs.writeFileSync(subscriptionsFile, JSON.stringify(activeSubscriptions, null, 2), 'utf8');
}