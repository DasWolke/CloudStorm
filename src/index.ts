import Client = require("./Client");
import Constants = require("./Constants");
import Intents = require("./Intents");

import Shard = require("./Shard");
import ShardManager = require("./ShardManager");

import BetterWs = require("./BetterWs");
import DiscordConnector = require("./DiscordConnector");
import eventSwitch = require("./eventSwitch");

export { BetterWs, DiscordConnector, Client, Constants, Intents, Shard, ShardManager, eventSwitch };
export * from "./Types";
