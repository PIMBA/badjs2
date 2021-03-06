var map = require('map-stream');
var fs = require('fs');
var service = 'badjs';
var cache = [];
// 100 MB
var MAX = 1024 * 1024 * 100;

function zero (num) {
    if ((num + '').length === 1) return '0' + num;
    return num + '';
}

function name () {
    var d = new Date();
    var year = d.getFullYear();
    var month = zero(d.getMonth());
    var date = zero(d.getDate());
    // need init
    if (
        !cache.length ||
        (cache[1] !== year || cache[2] !== month || cache[3] !== date)
    ) {
        cache.length = 0;
        cache.push(0, year, month, date);
    }
    return service + year + month + date + cache[0]++;
}

/**
 * save
 * @returns {Stream}
 */
module.exports = function () {
    var cur = MAX;
    var ws = fs.createWriteStream('./' + name() + '.log');
    var stream = map(function (data, fn) {
        ws.write(data);
        fn(null);
        cur -= data.length;
        if (cur < 0) {
            ws.end();
            ws = fs.createWriteStream('./' + name() + '.log');
            cur = MAX;
        }
    });
    return stream;
};
