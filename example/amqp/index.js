'use strict';
let CloudStorm = require('../../index').Client;
let token = require('../config.json').token;
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
        // Event was sent to amqp queue, now you can use it somewhere else
    });
    bot.on('ready', () => {
        console.log('Bot received ready event');
    });
};
startup().catch(e => {
    console.error('Error on startup!');
    console.error(e);
});

