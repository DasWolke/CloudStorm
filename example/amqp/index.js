'use strict';
let CloudStorm = require('../../index').Client;
let token = require('../config.json').token;
let bot = new CloudStorm(token, {
    initialPresence: {status: 'online', game: {name: 'test'}},
    firstShardId: 0,
    lastShardId: 0,
    shardAmount: 1
});
// let blocked = require('blocked');
// blocked(ms => {
//     console.log(`Blocked for ${ms}ms`);
// }, {threshold: 20});
let amqp = require('amqplib');
// const util = require('util');
let startup = async () => {
    let connection = await amqp.connect('amqp://localhost');
    let channel = await connection.createChannel();
    channel.assertQueue('test', {durable: false, autoDelete: true});
    await bot.connect();
    bot.on('event', (event) => {
        if (event.t !== 'PRESENCE_UPDATE') {
            if (event.t) {
                console.log(`Received Event ${event.t}`);
            } else {
                // console.log(event);
            }
        }
        channel.sendToQueue('test', Buffer.from(JSON.stringify(event)));
        // Event was sent to amqp queue, now you can use it somewhere else
    });
    bot.on('ready', () => {
        console.log('Bot is ready');
        // bot.shardManager.shards[0].connector.betterWs.sendMessage({
        //     op: 8,
        //     d: {guild_id: '206530953391243275', query: '', limit: 0}
        // });
    });
    bot.on('debug', (log) => {
        console.log('Debug:', log);
    });
    // bot.on('debug_receive', (log) => {
    //     console.log('Ws Receive Debug:', util.inspect(log, {depth:4}));
    // });
    // bot.on('debug_send', (log) => {
    //     console.log('Ws Debug:', util.inspect(log, {depth: 4}));
    // });
};
startup().catch(e => {
    console.error('Error on startup!');
    console.error(e);
});

