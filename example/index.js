'use strict';
let CloudStorm = require('../index').Client;
let token = require('./config.json').token;
let bot = new CloudStorm(token);
let amqp = require('amqplib');
let startup = async () => {
    let connection = await amqp.connect('amqp://localhost');
    let channel = await connection.createChannel();
    channel.assertQueue('test', {durable: false, autoDelete: true});
    await bot.connect();
    bot.on('event', (event) => {
        if (event.t !== 'PRESENCE_UPDATE') {
            console.log(event);
        }
        channel.sendToQueue('test', Buffer.from(JSON.stringify(event)));
    });
    bot.on('ready', () => {
        console.log('bot is ready owo');
    });
};
startup().then(() => {
    console.log('fulfilled');
}).catch(e => {
    console.log(e);
});

