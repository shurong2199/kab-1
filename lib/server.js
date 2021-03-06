/**
 * @file edp-test 的静态文件服务
 * @author chris<wfsr@foxmail.com>
 */

var fs       = require('fs');
var path     = require('path');
var istanbul = require('babel-istanbul');
var edp      = require('edp-core');

var log      = require('./log');

var config = require('./config').config;

/**
 * 生成所有样式的 HTML 代码
 *
 * @param {Array.<string>} files 所有指定的 CSS 文件路径
 * @return {string} 生成的 HTML 代码
 */
function buildCSSes(files) {
    var html = '';
    files.forEach(function (file) {
        html += '<link rel="stylesheet" href="' + file + '">\n';
    });
    return html;
}

function buildStyles(codes) {
    var html = '<style>\n';
    html += codes.join('\n');
    html += '\n</style>';
    return html;
}

/**
 * 生成全局 require 中的所有 Spec 代码
 *
 * @param {Array.<string>} files 所有指定的 Spec 文件路径
 * @return {string} 生成的 Spec 参数
 */
function buildSpecs(files) {
    var specs = [];
    files.forEach(function (file) {
        specs.push('\'' + file.replace(/\.(js|ts|dart|coffee)$/, '') + '\'');
    });
    return specs.join(', ');
}

function buildCases(file, opts) {
    var code = '\nsuite = new Benchmark.Suite(\'' + file.title + '\');\n';

    if (file.js[0]) {
        code += 'Benchmark.prototype.setup = function () {\n' + file.js[0] + '\n};\n';
    }

    if (file.js[1]) {
        code += 'Benchmark.prototype.teardown = function () {\n' + file.js[1] + '\n};\n';
    }

    var count = (opts.count | 0) || 10;
    code += file.cases.map(function (item) {
        return ''
            + 'suite.add(\''
            + item.name
            + '\', function () {\n'
            + item.js.join('\n')
            + '\n},'
            + '{initCount: ' + count + '});\n';
    }).join('');

    return code;
}

/**
 * 根据配置获取 runner、context 与 debug 的 HTML 模板内容
 *
 * @param {string} type 模板类型
 * @return {string} 模板内容
 */
function getTemplate(type) {
    var clientDir = path.resolve(__dirname, '../client/');
    var file;
    if (config.templates) {
        var tplFile = config.templates[type];
        tplFile = tplFile && path.resolve(process.cwd(), 'test/' + tplFile);
        if (fs.existsSync(tplFile)) {
            file = tplFile;
        }
    }
    file = file || path.resolve(clientDir, type + '.html');

    return fs.readFileSync(file, 'utf-8');
}

/**
 * 判断指定路径是否排除不作代码覆盖统计
 *
 * @param {string} pathname js 文件相对根目录的访问路径
 * @return {boolean} 是否命中被排除
 */
function isExcluded(pathname) {
    var exclude = config.coverageReporter.exclude || [];

    if (!exclude.length) {
        return false;
    }

    return edp.glob.match(pathname, exclude);
}

function buildTPL(tpl, files, frameworks, requireConfig, opts) {
    return tpl
        .replace(/<\!\-\-%css%\-\->/ig, function () {
            return buildCSSes(files.css || []);
        })
        .replace(/<\!\-\-%style%\-\->/ig, function () {
            return buildStyles(files.style || []);
        })
        .replace(/\s*\/\*specs\*\/\s*/ig, function () {
            return buildSpecs(files.js || []);
        })
        .replace(/\s*\/\*cases\*\/\s*/ig, function () {
            return buildCases(files, opts);
        })
        .replace(/<\!\-\-%html%\-\->/ig, function () {
            return (files.html || []).join('\n');
        })
        .replace(/\s*\/\*requireConfig\*\/\s*/ig, requireConfig)
        .replace(/<\!\-\-%frameworks%\-\->/ig, frameworks);
}

/**
 * 缓存 runner、context 与 debug 的 HTML 内容
 *
 * @namespace
 */
var cached = {};

/**
 * 生成 runner、context 与 debug 的 HTML 内容
 *
 * @param {EventEmitter} emitter 全局事件对象实例
 * @return {boolean} 是否成功生成
 */
exports.build = function (emitter) {
    log.trace('Build runner...');

    var contextTpl = getTemplate('context');
    var debugTpl = getTemplate('debug');

    var files = require('./files').readAll(config.files, config.exclude);
    if (files.js.length < 1 && (config.singleRun || !config.watch)) {
        return false;
    }

    var frameworks = require('./frameworks').render(config.frameworks);
    var requireConfig = JSON.stringify(config.requireConfig);

    config.requireConfig.urlArgs = 'debug=' + (+new Date()).toString(36);
    var debugRequireConfig = JSON.stringify(config.requireConfig);

    contextTpl = buildTPL(contextTpl, files, frameworks, requireConfig);
    debugTpl = buildTPL(debugTpl, files, frameworks, debugRequireConfig);

    cached.runner = getTemplate('runner');
    cached.context = contextTpl;
    cached.debug = debugTpl;

    log.trace('Runner build.');

    if (config.watch) {
        var watcher = require('chokidar').watch(files.css);
        watcher.add(files.js);
        watcher.on('change', function (path) {
            log.trace('%s changed.', path);
            emitter.emit('change', path);
        });
    }

    return true;
};

exports.bench = function (emitter, args, opts) {
    log.trace('Build runner...');

    var contextTpl = getTemplate('bm-context');
    var debugTpl = getTemplate('bm-debug');

    var files = require('./markdowns').readAll(args);
    var filesKeys = Object.keys(files);
    if (filesKeys.length < 1 && (config.singleRun || !config.watch)) {
        return false;
    }

    var frameworks = require('./frameworks').render(['benchmark']);
    var requireConfig = JSON.stringify(config.requireConfig);

    filesKeys.forEach(function (key) {
        var file = files[key];
        var tpl = buildTPL(contextTpl, file, frameworks, requireConfig, opts);
        cached['bm-context-' + key] = tpl;
        cached['bm-debug-' + key] = buildTPL(debugTpl, file, frameworks, requireConfig, opts);
    });


    cached['bm-runner'] = cached['bm-runner']
        || getTemplate('bm-runner').replace(/\s*\/\*pages\*\/\s*/ig, function () {
            return '\'' + filesKeys.join('\', \'') + '\'';
        });

    log.trace('Runner build.');

    if (config.watch) {
        var watcher = require('chokidar').watch(Object.keys(files));
        watcher.on('change', function (path) {
            log.trace('%s changed.', path);
            emitter.emit('change', path);
        });
    }

    return true;
};


/**
 * 简单的文件扩展名与 MIME 映射表
 *
 * @namespace
 */
var mimes = {
    js: 'application/javascript',
    css: 'text/css',
    html: 'text/html'
};

/**
 * 处理 runner、context 与 debug 等内置页面
 *
 * @param {string} name cached 对应的键名
 * @return {Function}
 */
exports.handler = function (name) {
    return function (context) {
        context.header['content-type'] = mimes.html;
        var query = context.request.query;
        var key = name;
        if ((key === 'bm-context' || key === 'bm-debug') && query && query.name) {
            key += '-' + query.name;
        }
        context.content = cached[key] || '';
    };
};

/**
 * 使用 instanbul instrument 代码
 *
 * @return {Functioin}
 */
exports.istanbul = function () {
    return function (context) {
        var pathname = context.request.pathname;
        if (context.request.query.debug) {
            return;
        }

        var docRoot  = context.conf.documentRoot;
        var src = docRoot + pathname;
        context.header['content-type'] = mimes.js;

        if (context.map) {
            var maps = global.maps;
            if (!maps) {
                maps = global.maps = {};
            }
            maps[src] = context.map;
            delete context.map;
        }

        var content = context.content || fs.readFileSync(src, 'utf-8');
        context.content = isExcluded(pathname)
            ? content
            : new istanbul.Instrumenter().instrumentSync(content, src);
    };
};

/**
 * 提供 jasmine 之类的静态文件服务
 *
 * @return {Function}
 */
exports.serve = function () {
    return function (context) {
        var pathname = context.request.pathname;
        var matches = pathname.match(/^\/.kab\/([^\?]+\.([^\?\.]+))/i);
        var src = path.resolve(__dirname, '../client', matches[1]);
        var ext = path.extname(pathname).slice(1).toLowerCase();

        context.header['content-type'] = mimes[ext] || mimes.html;
        context.content = fs.readFileSync(src, 'utf-8');
    };
};
