/* global process, global, GLOBAL */
var connect = require('connect'),
    log4js = require('log4js'),
    logger = log4js.getLogger();

var http = require("http");
var path = require("path");
var pako = require('pako');
var fs = require('fs');

var cluster = require('cluster');
var argv = process.argv.slice(2);

var REG_REFERER = /^https?:\/\/[^\/]+\//i;
var REG_DOMAIN = /^(?:https?:)?(?:\/\/)?([^\/]+\.[^\/]+)\/?/i;

var deflateObj = {
    f: 'from',
    l: 'level',
    m: 'msg',
    t: 'time',
    v: 'version'
};

if (argv.indexOf('--debug') >= 0) {
    logger.setLevel('DEBUG');
    global.debug = true;
} else {
    logger.setLevel('INFO');
}

if (argv.indexOf('--project') >= 0) {
    global.pjconfig = require(path.join(__dirname, 'project.debug.json'));
} else {
    global.pjconfig = require(path.join(__dirname, 'project.json'));
}

if (cluster.isMaster) {
    var clusters = [];
    // Fork workers.
    for (var i = 0; i < 4; i++) {
        var forkCluster = cluster.fork();
        clusters.push(forkCluster);
    }

    setTimeout(function () {
        require('./service/ProjectService')(clusters);
    }, 3000);

    return;
}

var interceptor = require('c-interceptor')();
var interceptors = global.pjconfig.interceptors;

interceptors.forEach(function (value, key) {
    var one = require(value)();
    interceptor.add(one);
});
interceptor.add(require(global.pjconfig.dispatcher.module)());

var forbiddenData = '403 forbidden';

global.projectsInfo = {};
global.offlineAutoInfo = {};

var get_domain = function (url) {
    return (url.toString().match(REG_DOMAIN) || ['', ''])[1].replace(/^\*\./, '');
};

var genBlacklistReg = function (data) {
    // ip黑名单正则
    var blacklistIPRegExpList = [];
    (data.blacklist && data.blacklist.ip ? data.blacklist.ip : []).forEach(function (reg) {
        blacklistIPRegExpList.push(new RegExp("^" + reg.replace(/\./g, "\\.")));
    });
    data.blacklistIPRegExpList = blacklistIPRegExpList;

    // ua黑名单正则
    var blacklistUARegExpList = [];
    (data.blacklist && data.blacklist.ua ? data.blacklist.ua : []).forEach(function (reg) {
        blacklistUARegExpList.push(new RegExp(reg, "i"));
    });
    data.blacklistUARegExpList = blacklistUARegExpList;

};

function getClientIp (req) {
    try {
        var xff = (
            req.headers['X-Forwarded-For'] ||
            req.headers['x-forwarded-for'] ||
            ''
        ).split(',')[0].trim();

        return xff ||
            req.connection.remoteAddress ||
            req.socket.remoteAddress ||
            req.connection.socket.remoteAddress;
    } catch (ex) {

    }

    return "0.0.0.0";
}

process.on('message', function (data) {
    var json = data, info;
    if (json.projectsInfo) {
        info = JSON.parse(json.projectsInfo);
        if (typeof info === "object") {
            for (var k in info) {
                var v = info[k] || {};
                v.domain = get_domain(v.url);
                genBlacklistReg(v);
            }
            global.projectsInfo = info;
        }
    }
});

/**
 * 校验来源的url 是否和填写的url相同
 * @param id
 * @param req
 * @returns {boolean}
 */
var referer_match = function (id, req) {
    var referer = (((req || {}).headers || {}).referer || "").toString();

    var projectMatchDomain = (global.projectsInfo[id.toString()] || {}).domain;
    // no referer
    if (!referer) {
        // match match is * , no detect referer
        if (!projectMatchDomain) {
            return true;
        }
        logger.debug('no referer ,  forbidden :' + req.query.id);
        return false;
    }
    var domain = (referer.match(REG_REFERER) || [""])[0] || "";
    return typeof global.projectsInfo === "object" &&
        domain.indexOf(projectMatchDomain) !== -1;
};

var reponseReject = function (req, res, responseHeader) {
    responseHeader['Content-length'] = forbiddenData.length;
    res.writeHead(403, responseHeader);
    res.write(forbiddenData);
    res.end();
};

connect()
    .use('/badjs', connect.query())
    .use('/badjs', connect.bodyParser())
    .use('/badjs/offlineLog', function (req, res) {

        // 大于 10ms , forbidden
        if (parseInt(req.headers['content-length']) > 10485760) {
            res.end('too large');
            return;
        }

        var offline_log = req.body.offline_log;

        // offline_log = pako.inflate(decodeURIComponent(offline_log), { to: 'string' });

        if (typeof offline_log === 'string') {
            offline_log = JSON.parse(offline_log);
        }

        if (!/[\w]{1,7}/.test(offline_log.id)) {
            throw new Error('invalid id ' + offline_log.id);
        }

        var filePath = path.join(global.pjconfig.offline.path, offline_log.id + "");

        var fileName = offline_log.uin + '_' + offline_log.startDate + '_' + offline_log.endDate;

        if (!fs.existsSync(filePath)) {
            fs.mkdirSync(filePath);
        }

        var logs = offline_log.logs;
        var msgObj = offline_log.msgObj;
        var urlObj = offline_log.urlObj;
        logs.map(function (log) {
            if (msgObj) {
                log.m = msgObj[log.m];
            }
            if (urlObj) {
                log.f = urlObj[log.f];
            }
            for (var k in deflateObj) {
                if (k in log) {
                    var v = deflateObj[k];
                    log[v] = log[k];
                    delete log[k];
                }
            }
            return log;
        });

        fs.writeFile(path.join(filePath, fileName), JSON.stringify(offline_log));

        res.end('ok');

    })
    .use('/badjs/offlineAuto', function (req, res) {
        var param = req.query;
        http.get(global.pjconfig.offline.offlineLogCheck + "?id=" + param.id + "&uin=" + param.uin, function (clientRes) {
            var result = "";
            clientRes.setEncoding('utf8');
            clientRes.on("data", function (chunk) {
                result += chunk;
            });

            clientRes.on("end", function () {
                //res.write()
                res.end("window && window._badjsOfflineAuto && window._badjsOfflineAuto(" + (result ? result : false) + ");");
            });
        }).on('error', function (e) {
            logger.warn("offlineLogCheck err , ", e);
            res.end("window && window._badjsOfflineAuto && window._badjsOfflineAuto(false);");
        });

    })
    .use('/badjs/mpOfflineAuto', function (req, res) {
        var param = req.query;

        http.get(global.pjconfig.offline.offlineLogCheck + "?id=" + param.id + "&uin=" + param.uin, function (clientRes) {
            var result = "";
            clientRes.setEncoding('utf8');
            clientRes.on("data", function (chunk) {
                result += chunk;
            });

            clientRes.on("end", function () {
                return res.end(JSON.stringify({
                    code: 200,
                    msg: result ? result : false
                }));
            });
        }).on('error', function (e) {
            logger.warn("offlineLogCheck err , ", e);
            return res.end(JSON.stringify({
                coo: 500,
                error: e
            }));
        });
    })
    .use('/badjs', function (req, res) {

        logger.debug('===== get a message =====');

        var responseHeader = {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'image/jpeg',
            'Connection': 'close'
        };


        var param = req.query;
        if (req.method === "POST" && !!req.body.id) {
            param = req.body;
        }


        var id = param.id - 0;
        if (isNaN(id) ||
            id <= 0 ||
            id >= 9999 ||
            !global.projectsInfo[id + ""] ||
            !referer_match(id, req)) {

            reponseReject(req, res, responseHeader);
            logger.debug('forbidden :' + param.id);

            return;
        }

        param.id = id;

        try {
            interceptor.invoke({
                req: req,
                data: param
            });
        } catch (err) {
            reponseReject(req, res, responseHeader);
            logger.debug('id ' + param.id + ' , interceptor error :' + err);
            return;
        }

        if (req.throwError) {
            reponseReject(req, res, responseHeader);
            logger.debug('id ' + param.id + ' , interceptor reject :' + req.throwError);
            return;
        }

        // responseHeader end with 204
        responseHeader['Content-length'] = 0;
        res.writeHead(204, responseHeader);

        logger.debug('===== complete a message =====');
        res.end();


    })
    //.use('/offlineLog', connect.bodyParser())
    .listen(global.pjconfig.port);

logger.info('start badjs-accepter , listen ' + global.pjconfig.port + ' ...');
