"use strict";
let Client = require("./src/Client");

function createClient(...args) {
	return new Client(...args);
}

createClient.Client = Client;
createClient.Constants = require("./src/Constants");
module.exports = createClient;
