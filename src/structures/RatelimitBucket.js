'use strict';

class RatelimitBucket {
    constructor(limit, clearTime) {
        this.queue = [];
        this.limit = limit;
        this.clearTime = Date.now();
    }

    queue() {
        return new Promise(async (res, rej) => {

        });
    }

}

module.exports = RatelimitBucket;
