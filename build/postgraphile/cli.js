#!/usr/bin/env node
"use strict";
// tslint:disable no-console
Object.defineProperty(exports, "__esModule", { value: true });
/*
 * IMPORTANT: the './postgraphilerc' import MUST come first!
 *
 * Reason: enables user to apply modifications to their Node.js environment
 * (e.g. sourcing modules that affect global state, like dotenv) before any of
 * our other require()s occur.
 */
const postgraphilerc_1 = require("./postgraphilerc");
const os = require("os");
const http_1 = require("http");
const chalk_1 = require("chalk");
const program = require("commander");
const pg_connection_string_1 = require("pg-connection-string");
const postgraphile_1 = require("./postgraphile");
const plugins_1 = require("../plugins");
const pg_1 = require("pg");
const cluster = require("cluster");
const pluginHook_1 = require("./pluginHook");
const debugFactory = require("debug");
// @ts-ignore Allow importing JSON
const manifest = require("../../package.json");
// @ts-ignore Allow importing JSON
const sponsors = require("../../sponsors.json");
const subscriptions_1 = require("./http/subscriptions");
const fs_1 = require("fs");
const tagsFile = process.cwd() + '/postgraphile.tags.json5';
/*
 * Watch mode on the tags file is non-trivial, so only load the plugin if the
 * file exists when PostGraphile starts.
 */
const smartTagsPlugin = fs_1.existsSync(tagsFile) ? plugins_1.makePgSmartTagsFromFilePlugin() : null;
const isDev = process.env.POSTGRAPHILE_ENV === 'development';
function isString(str) {
    return typeof str === 'string';
}
const sponsor = sponsors[Math.floor(sponsors.length * Math.random())];
const debugCli = debugFactory('postgraphile:cli');
// TODO: Demo Postgres database
const DEMO_PG_URL = null;
function extractPlugins(rawArgv) {
    let argv;
    let pluginStrings = [];
    if (rawArgv[2] === '--plugins') {
        pluginStrings = rawArgv[3].split(',');
        argv = [...rawArgv.slice(0, 2), ...rawArgv.slice(4)];
    }
    else {
        pluginStrings = (postgraphilerc_1.default && postgraphilerc_1.default['options'] && postgraphilerc_1.default['options']['plugins']) || [];
        argv = rawArgv;
    }
    const plugins = pluginStrings.map((pluginString) => {
        debugCli('Loading plugin %s', pluginString);
        const rawPlugin = require(pluginString); // tslint:disable-lin no-var-requires
        if (rawPlugin['default'] && typeof rawPlugin['default'] === 'object') {
            return rawPlugin['default'];
        }
        else {
            return rawPlugin;
        }
    });
    return { argv, plugins };
}
const { argv: argvSansPlugins, plugins: extractedPlugins } = extractPlugins(process.argv);
const pluginHook = pluginHook_1.makePluginHook(extractedPlugins);
program.version(manifest.version).usage('[options...]').description(manifest.description);
function addFlag(optionString, description, parse) {
    program.option(optionString, description, parse);
    return addFlag;
}
// Standard options
program
    .option('--plugins <string>', 'a list of PostGraphile server plugins (not Graphile Engine schema plugins) to load; if present, must be the _first_ option')
    .option('-c, --connection <string>', "the PostgreSQL database name or connection string. If omitted, inferred from environmental variables (see https://www.postgresql.org/docs/current/static/libpq-envars.html). Examples: 'db', 'postgres:///db', 'postgres://user:password@domain:port/db?ssl=true'")
    .option('-C, --owner-connection <string>', 'as `--connection`, but for a privileged user (e.g. for setting up watch fixtures, logical decoding, etc); defaults to the value from `--connection`')
    .option('-s, --schema <string>', 'a Postgres schema to be introspected. Use commas to define multiple schemas', (option) => option.split(','))
    .option('-S, --subscriptions', 'Enable GraphQL support for subscriptions (you still need a subscriptions plugin currently)')
    .option('--websockets <string>', "Choose which websocket transport libraries to use. Use commas to define multiple. Defaults to 'v0,v1' if `--subscriptions` or `--live` were passed, '[]' otherwise", (option) => option.split(','))
    .option('--websocket-operations <operations>', "Toggle which GraphQL websocket transport operations are supported: 'subscriptions' or 'all'. Defaults to 'subscriptions'")
    .option('-L, --live', '[EXPERIMENTAL] Enables live-query support via GraphQL subscriptions (sends updated payload any time nested collections/records change). Implies --subscriptions')
    .option('-w, --watch', 'automatically updates your GraphQL schema when your database schema changes (NOTE: requires DB superuser to install `postgraphile_watch` schema)')
    .option('-n, --host <string>', 'the hostname to be used. Defaults to `localhost`')
    .option('-p, --port <number>', 'the port to be used. Defaults to 5000', parseFloat)
    .option('-m, --max-pool-size <number>', 'the maximum number of clients to keep in the Postgres pool. defaults to 10', parseFloat)
    .option('-r, --default-role <string>', 'the default Postgres role to use when a request is made. supercedes the role used to connect to the database')
    .option('--retry-on-init-fail', 'if an error occurs building the initial schema, this flag will cause PostGraphile to keep trying to build the schema with exponential backoff rather than exiting');
pluginHook('cli:flags:add:standard', addFlag);
// Schema configuration
program
    .option('-j, --dynamic-json', '[RECOMMENDED] enable dynamic JSON in GraphQL inputs and outputs. PostGraphile uses stringified JSON by default')
    .option('-N, --no-setof-functions-contain-nulls', '[RECOMMENDED] if none of your `RETURNS SETOF compound_type` functions mix NULLs with the results then you may enable this to reduce the nullables in the GraphQL schema')
    .option('-a, --classic-ids', 'use classic global id field name. required to support Relay 1')
    .option('-M, --disable-default-mutations', 'disable default mutations, mutation will only be possible through Postgres functions')
    .option('--simple-collections <omit|both|only>', '"omit" (default) - relay connections only, "only" - simple collections only (no Relay connections), "both" - both')
    .option('--no-ignore-rbac', '[RECOMMENDED] set this to exclude fields, queries and mutations that are not available to any possible user (determined from the user in connection string and any role they can become); this will be enabled by default in v5')
    .option('--no-ignore-indexes', '[RECOMMENDED] set this to exclude filters, orderBy, and relations that would be expensive to access due to missing indexes')
    .option('--include-extension-resources', 'by default, tables and functions that come from extensions are excluded; use this flag to include them (not recommended)');
pluginHook('cli:flags:add:schema', addFlag);
// Error enhancements
program
    .option('--show-error-stack [json|string]', 'show JavaScript error stacks in the GraphQL result errors (recommended in development)')
    .option('--extended-errors <string>', "a comma separated list of extended Postgres error fields to display in the GraphQL result. Recommended in development: 'hint,detail,errcode'. Default: none", (option) => option.split(',').filter(_ => _));
pluginHook('cli:flags:add:errorHandling', addFlag);
// Plugin-related options
program
    .option('--append-plugins <string>', 'a comma-separated list of plugins to append to the list of Graphile Engine schema plugins')
    .option('--prepend-plugins <string>', 'a comma-separated list of plugins to prepend to the list of Graphile Engine schema plugins')
    .option('--skip-plugins <string>', 'a comma-separated list of Graphile Engine schema plugins to skip');
pluginHook('cli:flags:add:plugins', addFlag);
// Things that relate to -X
program
    .option('--read-cache <path>', '[experimental] reads cached values from local cache file to improve startup time (you may want to do this in production)')
    .option('--write-cache <path>', '[experimental] writes computed values to local cache file so startup can be faster (do this during the build phase)')
    .option('--export-schema-json <path>', 'enables exporting the detected schema, in JSON format, to the given location. The directories must exist already, if the file exists it will be overwritten.')
    .option('--export-schema-graphql <path>', 'enables exporting the detected schema, in GraphQL schema format, to the given location. The directories must exist already, if the file exists it will be overwritten.')
    .option('--sort-export', 'lexicographically (alphabetically) sort exported schema for more stable diffing.')
    .option('-X, --no-server', '[experimental] for when you just want to use --write-cache or --export-schema-* and not actually run a server (e.g. CI)');
pluginHook('cli:flags:add:noServer', addFlag);
// Webserver configuration
program
    .option('-q, --graphql <path>', 'the route to mount the GraphQL server on. defaults to `/graphql`')
    .option('-i, --graphiql <path>', 'the route to mount the GraphiQL interface on. defaults to `/graphiql`')
    .option('--enhance-graphiql', '[DEVELOPMENT] opt in to additional GraphiQL functionality (this may change over time - only intended for use in development; automatically enables with `subscriptions` and `live`)')
    .option('-b, --disable-graphiql', 'disables the GraphiQL interface. overrides the GraphiQL route option')
    .option('-o, --cors', 'enable generous CORS settings; disabled by default, if possible use a proxy instead')
    .option('-l, --body-size-limit <string>', "set the maximum size of the HTTP request body that can be parsed (default 100kB). The size can be given as a human-readable string, such as '200kB' or '5MB' (case insensitive).")
    .option('--timeout <number>', 'set the timeout value in milliseconds for sockets', parseFloat)
    .option('--cluster-workers <count>', '[experimental] spawn <count> workers to increase throughput', parseFloat)
    .option('--enable-query-batching', '[experimental] enable the server to process multiple GraphQL queries in one request')
    .option('--disable-query-log', 'disable logging queries to console (recommended in production)')
    .option('--allow-explain', '[EXPERIMENTAL] allows users to use the Explain button in GraphiQL to view the plan for the SQL that is executed (DO NOT USE IN PRODUCTION)');
pluginHook('cli:flags:add:webserver', addFlag);
// JWT-related options
program
    .option('-e, --jwt-secret <string>', 'the secret to be used when creating and verifying JWTs. if none is provided auth will be disabled')
    .option('--jwt-verify-algorithms <string>', 'a comma separated list of the names of the allowed jwt token algorithms', (option) => option.split(','))
    .option('-A, --jwt-verify-audience <string>', "a comma separated list of JWT audiences that will be accepted; defaults to 'postgraphile'. To disable audience verification, set to ''.", (option) => option.split(',').filter(_ => _))
    .option('--jwt-verify-clock-tolerance <number>', 'number of seconds to tolerate when checking the nbf and exp claims, to deal with small clock differences among different servers', parseFloat)
    .option('--jwt-verify-id <string>', 'the name of the allowed jwt token id')
    .option('--jwt-verify-ignore-expiration', 'if `true` do not validate the expiration of the token defaults to `false`')
    .option('--jwt-verify-ignore-not-before', 'if `true` do not validate the notBefore of the token defaults to `false`')
    .option('--jwt-verify-issuer <string>', 'a comma separated list of the names of the allowed jwt token issuer', (option) => option.split(','))
    .option('--jwt-verify-subject <string>', 'the name of the allowed jwt token subject')
    .option('--jwt-role <string>', 'a comma seperated list of strings that create a path in the jwt from which to extract the postgres role. if none is provided it will use the key `role` on the root of the jwt.', (option) => option.split(','))
    .option('-t, --jwt-token-identifier <identifier>', 'the Postgres identifier for a composite type that will be used to create JWT tokens');
pluginHook('cli:flags:add:jwt', addFlag);
// Any other options
pluginHook('cli:flags:add', addFlag);
// Deprecated
program
    .option('--token <identifier>', '[DEPRECATED] Use --jwt-token-identifier instead. This option will be removed in v5.')
    .option('--secret <string>', '[DEPRECATED] Use --jwt-secret instead. This option will be removed in v5.')
    .option('--jwt-audiences <string>', '[DEPRECATED] Use --jwt-verify-audience instead. This option will be removed in v5.', (option) => option.split(','))
    .option('--legacy-functions-only', '[DEPRECATED] PostGraphile 4.1.0 introduced support for PostgreSQL functions than declare parameters with IN/OUT/INOUT or declare RETURNS TABLE(...); enable this flag to ignore these types of functions. This option will be removed in v5.');
pluginHook('cli:flags:add:deprecated', addFlag);
// Awkward application workarounds / legacy support
program
    .option('--legacy-relations <omit|deprecated|only>', "some one-to-one relations were previously detected as one-to-many - should we export 'only' the old relation shapes, both new and old but mark the old ones as 'deprecated', or 'omit' the old relation shapes entirely")
    .option('--legacy-json-uuid', `ONLY use this option if you require the v3 typenames 'Json' and 'Uuid' over 'JSON' and 'UUID'`);
pluginHook('cli:flags:add:workarounds', addFlag);
program.on('--help', () => {
    console.log(`
Get started:

  $ postgraphile
  $ postgraphile -c postgres://localhost/my_db
  $ postgraphile --connection postgres://user:pass@localhost/my_db --schema my_schema --watch --dynamic-json
`);
    process.exit(0);
});
program.parse(argvSansPlugins);
function exitWithErrorMessage(message) {
    console.error(message);
    console.error();
    console.error('For help, run `postgraphile --help`');
    process.exit(1);
}
if (program.args.length) {
    exitWithErrorMessage(`ERROR: some of the parameters you passed could not be processed: '${program.args.join("', '")}'`);
}
if (program['plugins']) {
    exitWithErrorMessage(`--plugins must be the first argument to postgraphile if specified`);
}
// Kill server on exit.
process.on('SIGINT', () => {
    process.exit(1);
});
// For `--no-*` options, `program` automatically contains the default,
// overriding our options. We typically want the CLI to "win", but not
// with defaults! So this code extracts those `--no-*` values and
// re-overwrites the values if necessary.
const configOptions = postgraphilerc_1.default['options'] || {};
const overridesFromOptions = {};
['ignoreIndexes', 'ignoreRbac', 'setofFunctionsContainNulls'].forEach(option => {
    if (option in configOptions) {
        overridesFromOptions[option] = configOptions[option];
    }
});
// Destruct our configuration file and command line arguments, use defaults, and rename options to
// something appropriate for JavaScript.
const { demo: isDemo = false, connection: pgConnectionString, ownerConnection, subscriptions, live, websockets = subscriptions || live ? ['v0', 'v1'] : [], websocketOperations = 'subscriptions', watch: watchPg, schema: dbSchema, host: hostname = 'localhost', port = 5000, timeout: serverTimeout, maxPoolSize, defaultRole: pgDefaultRole, retryOnInitFail, graphql: graphqlRoute = '/graphql', graphiql: graphiqlRoute = '/graphiql', enhanceGraphiql = false, disableGraphiql = false, secret: deprecatedJwtSecret, jwtSecret, jwtPublicKey, jwtAudiences, jwtVerifyAlgorithms, jwtVerifyAudience, jwtVerifyClockTolerance, jwtVerifyId, jwtVerifyIgnoreExpiration, jwtVerifyIgnoreNotBefore, jwtVerifyIssuer, jwtVerifySubject, jwtSignOptions = {}, jwtVerifyOptions: rawJwtVerifyOptions, jwtRole = ['role'], token: deprecatedJwtPgTypeIdentifier, jwtTokenIdentifier: jwtPgTypeIdentifier, cors: enableCors = false, classicIds = false, dynamicJson = false, disableDefaultMutations = false, ignoreRbac = true, includeExtensionResources = false, exportSchemaJson: exportJsonSchemaPath, exportSchemaGraphql: exportGqlSchemaPath, sortExport = false, showErrorStack: rawShowErrorStack, extendedErrors = [], bodySizeLimit, appendPlugins: appendPluginNames, prependPlugins: prependPluginNames, 
// replaceAllPlugins is NOT exposed via the CLI
skipPlugins: skipPluginNames, readCache, writeCache, legacyRelations: rawLegacyRelations = 'deprecated', server: yesServer, clusterWorkers, enableQueryBatching, setofFunctionsContainNulls = true, legacyJsonUuid, disableQueryLog, allowExplain, simpleCollections, legacyFunctionsOnly, ignoreIndexes, } = Object.assign(Object.assign(Object.assign({}, postgraphilerc_1.default['options']), program), overridesFromOptions);
const showErrorStack = (val => {
    switch (val) {
        case 'string':
        case true:
            return true;
        case null:
        case undefined:
            return undefined;
        case 'json':
            return 'json';
        default: {
            exitWithErrorMessage(`Invalid argument for '--show-error-stack' - expected no argument, or 'string' or 'json'`);
        }
    }
})(rawShowErrorStack);
if (allowExplain && !disableGraphiql && !enhanceGraphiql) {
    exitWithErrorMessage('`--allow-explain` requires `--enhance-graphiql` or `--disable-graphiql`');
}
let legacyRelations;
if (!['omit', 'only', 'deprecated'].includes(rawLegacyRelations)) {
    exitWithErrorMessage(`Invalid argument to '--legacy-relations' - expected on of 'omit', 'deprecated', 'only'; but received '${rawLegacyRelations}'`);
}
else {
    legacyRelations = rawLegacyRelations;
}
// Validate websockets argument
if (
// must be array
!Array.isArray(websockets) ||
    // empty array = 'none'
    (websockets.length &&
        // array can only hold the versions
        websockets.some(ver => !['v0', 'v1'].includes(ver)))) {
    exitWithErrorMessage(`Invalid argument to '--websockets' - expected 'v0' and/or 'v1' (separated by comma); but received '${websockets}'`);
}
if (websocketOperations !== 'subscriptions' && websocketOperations !== 'all') {
    exitWithErrorMessage(`Invalid argument to '--websocket-operations' - expected 'subscriptions' or 'all' but received '${websocketOperations}'`);
}
const noServer = !yesServer;
// Add custom logic for getting the schemas from our CLI. If we are in demo
// mode, we want to use the `forum_example` schema. Otherwise the `public`
// schema is what we want.
const schemas = dbSchema || (isDemo ? ['forum_example'] : ['public']);
const ownerConnectionString = ownerConnection || pgConnectionString || process.env.DATABASE_URL;
// Work around type mismatches between parsePgConnectionString and PoolConfig
const coerce = (o) => {
    const port = typeof o.port === 'number'
        ? o.port
        : typeof o.port === 'string'
            ? parseInt(o.port, 10)
            : undefined;
    return Object.assign(Object.assign({}, o), { application_name: o['application_name'] || undefined, ssl: o.ssl == null
            ? undefined
            : o.ssl.rejectUnauthorized == null
                ? !!o.ssl
                : o.ssl, user: typeof o.user === 'string' ? o.user : undefined, database: typeof o.database === 'string' ? o.database : undefined, password: typeof o.password === 'string' ? o.password : undefined, port: Number.isFinite(port) ? port : undefined, host: typeof o.host === 'string' ? o.host : undefined });
};
// Create our Postgres config.
const pgConfig = Object.assign(Object.assign({}, (pgConnectionString || process.env.DATABASE_URL || isDemo
    ? coerce(pg_connection_string_1.parse(pgConnectionString || process.env.DATABASE_URL || DEMO_PG_URL))
    : {
        host: process.env.PGHOST || process.env.PGHOSTADDR || 'localhost',
        port: (process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : null) || 5432,
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
    })), { 
    // Add the max pool size to our config.
    max: maxPoolSize });
const loadPlugins = (rawNames) => {
    if (!rawNames) {
        return undefined;
    }
    const names = Array.isArray(rawNames) ? rawNames : String(rawNames).split(',');
    return names.map(rawName => {
        if (typeof rawName === 'function') {
            return rawName;
        }
        const name = String(rawName);
        const parts = name.split(':');
        if (process.platform === 'win32' &&
            parts[0].length === 1 &&
            /^[a-z]$/i.test(parts[0]) &&
            ['\\', '/'].includes(name[2])) {
            // Assume this is a windows path `C:/path/to/module.js` or `C:\path\to\module.js`
            const driveLetter = parts.shift();
            // Add the drive part back onto the path
            parts[0] = `${driveLetter}:${parts[0]}`;
        }
        let root;
        try {
            root = require(String(parts.shift()));
        }
        catch (e) {
            // tslint:disable-next-line no-console
            console.error(`Failed to load plugin '${name}'`);
            throw e;
        }
        let plugin = root;
        let part;
        while ((part = parts.shift())) {
            plugin = plugin[part];
            if (plugin == null) {
                throw new Error(`No plugin found matching spec '${name}' - failed at '${part}'`);
            }
        }
        if (typeof plugin === 'function') {
            return plugin;
        }
        else if (plugin === root && typeof plugin.default === 'function') {
            return plugin.default; // ES6 workaround
        }
        else {
            throw new Error(`No plugin found matching spec '${name}' - expected function, found '${typeof plugin}'`);
        }
    });
};
if (jwtAudiences != null && jwtVerifyAudience != null) {
    exitWithErrorMessage(`Provide either '--jwt-audiences' or '-A, --jwt-verify-audience' but not both`);
}
function trimNulls(obj) {
    return Object.keys(obj).reduce((memo, key) => {
        if (obj[key] != null) {
            memo[key] = obj[key];
        }
        return memo;
    }, {});
}
if (rawJwtVerifyOptions &&
    (jwtVerifyAlgorithms ||
        jwtVerifyAudience ||
        jwtVerifyClockTolerance ||
        jwtVerifyId ||
        jwtVerifyIgnoreExpiration ||
        jwtVerifyIgnoreNotBefore ||
        jwtVerifyIssuer ||
        jwtVerifySubject)) {
    exitWithErrorMessage('You may not mix `jwtVerifyOptions` with the legacy `jwtVerify*` settings; please only provide `jwtVerifyOptions`.');
}
const jwtVerifyOptions = rawJwtVerifyOptions
    ? rawJwtVerifyOptions
    : trimNulls({
        algorithms: jwtVerifyAlgorithms,
        audience: jwtVerifyAudience,
        clockTolerance: jwtVerifyClockTolerance,
        jwtId: jwtVerifyId,
        ignoreExpiration: jwtVerifyIgnoreExpiration,
        ignoreNotBefore: jwtVerifyIgnoreNotBefore,
        issuer: jwtVerifyIssuer,
        subject: jwtVerifySubject,
    });
const appendPlugins = loadPlugins(appendPluginNames);
const prependPlugins = loadPlugins(prependPluginNames);
const skipPlugins = loadPlugins(skipPluginNames);
// The options to pass through to the schema builder, or the middleware
const postgraphileOptions = pluginHook('cli:library:options', Object.assign(Object.assign({}, postgraphilerc_1.default['options']), { classicIds,
    dynamicJson,
    disableDefaultMutations, ignoreRBAC: ignoreRbac, includeExtensionResources,
    graphqlRoute,
    graphiqlRoute, graphiql: !disableGraphiql, enhanceGraphiql: enhanceGraphiql ? true : undefined, jwtPgTypeIdentifier: jwtPgTypeIdentifier || deprecatedJwtPgTypeIdentifier, jwtSecret: jwtSecret || deprecatedJwtSecret || process.env.JWT_SECRET, jwtPublicKey,
    jwtAudiences,
    jwtSignOptions,
    jwtRole,
    jwtVerifyOptions,
    retryOnInitFail,
    pgDefaultRole, subscriptions: subscriptions || live, websockets,
    websocketOperations,
    live,
    watchPg,
    showErrorStack,
    extendedErrors,
    disableQueryLog, allowExplain: allowExplain ? true : undefined, enableCors,
    exportJsonSchemaPath,
    exportGqlSchemaPath,
    sortExport,
    bodySizeLimit, appendPlugins: smartTagsPlugin ? [smartTagsPlugin, ...(appendPlugins || [])] : appendPlugins, prependPlugins,
    skipPlugins,
    readCache,
    writeCache,
    legacyRelations,
    setofFunctionsContainNulls,
    legacyJsonUuid,
    enableQueryBatching,
    pluginHook,
    simpleCollections,
    legacyFunctionsOnly,
    ignoreIndexes,
    ownerConnectionString }), { config: postgraphilerc_1.default, cliOptions: program });
function killAllWorkers(signal = 'SIGTERM') {
    for (const id in cluster.workers) {
        const worker = cluster.workers[id];
        if (Object.prototype.hasOwnProperty.call(cluster.workers, id) && worker) {
            worker.kill(signal);
        }
    }
}
if (noServer) {
    // No need for a server, let's just spin up the schema builder
    (async () => {
        const pgPool = new pg_1.Pool(pgConfig);
        pgPool.on('error', err => {
            // tslint:disable-next-line no-console
            console.error('PostgreSQL client generated error: ', err.message);
        });
        const { getGraphQLSchema } = postgraphile_1.getPostgraphileSchemaBuilder(pgPool, schemas, postgraphileOptions);
        await getGraphQLSchema();
        if (!watchPg) {
            await pgPool.end();
        }
    })().then(null, e => {
        console.error('Error occurred!');
        console.error(e);
        process.exit(1);
    });
}
else {
    if (clusterWorkers >= 2 && cluster.isMaster) {
        let shuttingDown = false;
        const shutdown = () => {
            if (!shuttingDown) {
                shuttingDown = true;
                process.exitCode = 1;
                const fallbackTimeout = setTimeout(() => {
                    const remainingCount = Object.keys(cluster.workers).length;
                    if (remainingCount > 0) {
                        console.log(`  [cluster] ${remainingCount} workers did not die fast enough, sending SIGKILL`);
                        killAllWorkers('SIGKILL');
                        const ultraFallbackTimeout = setTimeout(() => {
                            console.log(`  [cluster] really should have exited automatically, but haven't - exiting`);
                            process.exit(3);
                        }, 5000);
                        ultraFallbackTimeout.unref();
                    }
                    else {
                        console.log(`  [cluster] should have exited automatically, but haven't - exiting`);
                        process.exit(2);
                    }
                }, 5000);
                fallbackTimeout.unref();
                console.log(`  [cluster] killing other workers with SIGTERM`);
                killAllWorkers('SIGTERM');
            }
        };
        cluster.on('exit', (worker, code, signal) => {
            console.log(`  [cluster] worker pid=${worker.process.pid} exited (code=${code}, signal=${signal})`);
            shutdown();
        });
        for (let i = 0; i < clusterWorkers; i++) {
            const worker = cluster.fork({
                POSTGRAPHILE_WORKER_NUMBER: String(i + 1),
            });
            console.log(`  [cluster] started worker ${i + 1} (pid=${worker.process.pid})`);
        }
    }
    else {
        // Create’s our PostGraphile server
        const rawMiddleware = postgraphile_1.default(pgConfig, schemas, postgraphileOptions);
        // You probably don't want this hook; likely you want
        // `postgraphile:middleware` instead. This hook will likely be removed in
        // future without warning.
        const middleware = pluginHook(
        /* DO NOT USE -> */ 'cli:server:middleware' /* <- DO NOT USE */, rawMiddleware, {
            options: postgraphileOptions,
        });
        const server = http_1.createServer(middleware);
        if (serverTimeout) {
            server.timeout = serverTimeout;
        }
        if (websockets.length) {
            subscriptions_1.enhanceHttpServerWithWebSockets(server, middleware);
        }
        pluginHook('cli:server:created', server, {
            options: postgraphileOptions,
            middleware,
        });
        // Start our server by listening to a specific port and host name. Also log
        // some instructions and other interesting information.
        server.listen(port, hostname, () => {
            const address = server.address();
            const actualPort = typeof address === 'string' ? port : address.port;
            const self = cluster.isMaster
                ? isDev
                    ? `server (pid=${process.pid})`
                    : 'server'
                : `worker ${process.env.POSTGRAPHILE_WORKER_NUMBER} (pid=${process.pid})`;
            const versionString = `v${manifest.version}`;
            if (cluster.isMaster || process.env.POSTGRAPHILE_WORKER_NUMBER === '1') {
                console.log('');
                console.log(`PostGraphile ${versionString} ${self} listening on port ${chalk_1.default.underline(actualPort.toString())} 🚀`);
                console.log('');
                const { host: rawPgHost, port: rawPgPort, database: pgDatabase, user: pgUser, password: pgPassword, } = pgConfig;
                // Not using default because want to handle the empty string also.
                const pgHost = rawPgHost || 'localhost';
                const pgPort = (rawPgPort && parseInt(String(rawPgPort), 10)) || 5432;
                const safeConnectionString = isDemo
                    ? 'postgraphile_demo'
                    : `postgres://${pgUser ? pgUser : ''}${pgPassword ? ':[SECRET]' : ''}${pgUser || pgPassword ? '@' : ''}${pgUser || pgPassword || pgHost !== 'localhost' || pgPort !== 5432 ? pgHost : ''}${pgPort !== 5432 ? `:${pgConfig.port || 5432}` : ''}${pgDatabase ? `/${pgDatabase}` : ''}`;
                const information = pluginHook('cli:greeting', [
                    `GraphQL API:         ${chalk_1.default.underline.bold.blue(`http://${hostname}:${actualPort}${graphqlRoute}`)}` +
                        (postgraphileOptions.subscriptions
                            ? ` (${postgraphileOptions.live ? 'live ' : ''}subscriptions enabled)`
                            : ''),
                    !disableGraphiql &&
                        `GraphiQL GUI/IDE:    ${chalk_1.default.underline.bold.blue(`http://${hostname}:${actualPort}${graphiqlRoute}`)}` +
                            (postgraphileOptions.enhanceGraphiql ||
                                postgraphileOptions.live ||
                                postgraphileOptions.subscriptions
                                ? ''
                                : ` (${chalk_1.default.bold('RECOMMENDATION')}: add '--enhance-graphiql')`),
                    `Postgres connection: ${chalk_1.default.underline.magenta(safeConnectionString)}${postgraphileOptions.watchPg ? ' (watching)' : ''}`,
                    `Postgres schema(s):  ${schemas.map(schema => chalk_1.default.magenta(schema)).join(', ')}`,
                    `Documentation:       ${chalk_1.default.underline(`https://graphile.org/postgraphile/introduction/`)}`,
                    `Node.js version:     ${process.version} on ${os.platform()} ${os.arch()}`,
                    extractedPlugins.length === 0
                        ? `Join ${chalk_1.default.bold(sponsor)} in supporting PostGraphile development: ${chalk_1.default.underline.bold.blue(`https://graphile.org/sponsor/`)}`
                        : null,
                ], {
                    options: postgraphileOptions,
                    middleware,
                    port: actualPort,
                    chalk: chalk_1.default,
                }).filter(isString);
                console.log(information.map(msg => `  ‣ ${msg}`).join('\n'));
                console.log('');
                console.log(chalk_1.default.gray('* * *'));
            }
            else {
                console.log(`PostGraphile ${versionString} ${self} listening on port ${chalk_1.default.underline(actualPort.toString())} 🚀`);
            }
            console.log('');
        });
    }
}
/* eslint-enable */
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3Bvc3RncmFwaGlsZS9jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFDQSw0QkFBNEI7O0FBRTVCOzs7Ozs7R0FNRztBQUNILHFEQUFzQztBQUV0Qyx5QkFBeUI7QUFDekIsK0JBQW9DO0FBQ3BDLGlDQUEwQjtBQUMxQixxQ0FBc0M7QUFFdEMsK0RBQXdFO0FBQ3hFLGlEQUE0RTtBQUM1RSx3Q0FBMkQ7QUFDM0QsMkJBQXNDO0FBQ3RDLG1DQUFvQztBQUNwQyw2Q0FBa0U7QUFDbEUsc0NBQXVDO0FBRXZDLGtDQUFrQztBQUNsQywrQ0FBK0M7QUFDL0Msa0NBQWtDO0FBQ2xDLGdEQUFpRDtBQUNqRCx3REFBdUU7QUFDdkUsMkJBQWdDO0FBRWhDLE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRywwQkFBMEIsQ0FBQztBQUM1RDs7O0dBR0c7QUFDSCxNQUFNLGVBQWUsR0FBRyxlQUFVLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLHVDQUE2QixFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUV0RixNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixLQUFLLGFBQWEsQ0FBQztBQUU3RCxTQUFTLFFBQVEsQ0FBQyxHQUFZO0lBQzVCLE9BQU8sT0FBTyxHQUFHLEtBQUssUUFBUSxDQUFDO0FBQ2pDLENBQUM7QUFFRCxNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFFdEUsTUFBTSxRQUFRLEdBQUcsWUFBWSxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFFbEQsK0JBQStCO0FBQy9CLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQztBQUV6QixTQUFTLGNBQWMsQ0FDckIsT0FBc0I7SUFLdEIsSUFBSSxJQUFJLENBQUM7SUFDVCxJQUFJLGFBQWEsR0FBRyxFQUFFLENBQUM7SUFDdkIsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssV0FBVyxFQUFFO1FBQzlCLGFBQWEsR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3RDLElBQUksR0FBRyxDQUFDLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUUsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7S0FDdEQ7U0FBTTtRQUNMLGFBQWEsR0FBRyxDQUFDLHdCQUFNLElBQUksd0JBQU0sQ0FBQyxTQUFTLENBQUMsSUFBSSx3QkFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3BGLElBQUksR0FBRyxPQUFPLENBQUM7S0FDaEI7SUFDRCxNQUFNLE9BQU8sR0FBRyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUMsWUFBb0IsRUFBRSxFQUFFO1FBQ3pELFFBQVEsQ0FBQyxtQkFBbUIsRUFBRSxZQUFZLENBQUMsQ0FBQztRQUM1QyxNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxxQ0FBcUM7UUFDOUUsSUFBSSxTQUFTLENBQUMsU0FBUyxDQUFDLElBQUksT0FBTyxTQUFTLENBQUMsU0FBUyxDQUFDLEtBQUssUUFBUSxFQUFFO1lBQ3BFLE9BQU8sU0FBUyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1NBQzdCO2FBQU07WUFDTCxPQUFPLFNBQVMsQ0FBQztTQUNsQjtJQUNILENBQUMsQ0FBQyxDQUFDO0lBQ0gsT0FBTyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsQ0FBQztBQUMzQixDQUFDO0FBRUQsTUFBTSxFQUFFLElBQUksRUFBRSxlQUFlLEVBQUUsT0FBTyxFQUFFLGdCQUFnQixFQUFFLEdBQUcsY0FBYyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUUxRixNQUFNLFVBQVUsR0FBRywyQkFBYyxDQUFDLGdCQUFnQixDQUFDLENBQUM7QUFFcEQsT0FBTyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsS0FBSyxDQUFDLGNBQWMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLENBQUM7QUFTMUYsU0FBUyxPQUFPLENBQ2QsWUFBb0IsRUFDcEIsV0FBbUIsRUFDbkIsS0FBaUM7SUFFakMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxZQUFZLEVBQUUsV0FBVyxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQ2pELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxtQkFBbUI7QUFDbkIsT0FBTztLQUNKLE1BQU0sQ0FDTCxvQkFBb0IsRUFDcEIsNEhBQTRILENBQzdIO0tBQ0EsTUFBTSxDQUNMLDJCQUEyQixFQUMzQixtUUFBbVEsQ0FDcFE7S0FDQSxNQUFNLENBQ0wsaUNBQWlDLEVBQ2pDLHFKQUFxSixDQUN0SjtLQUNBLE1BQU0sQ0FDTCx1QkFBdUIsRUFDdkIsNkVBQTZFLEVBQzdFLENBQUMsTUFBYyxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUN0QztLQUNBLE1BQU0sQ0FDTCxxQkFBcUIsRUFDckIsNEZBQTRGLENBQzdGO0tBQ0EsTUFBTSxDQUNMLHVCQUF1QixFQUN2QixvS0FBb0ssRUFDcEssQ0FBQyxNQUFjLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQ3RDO0tBQ0EsTUFBTSxDQUNMLHFDQUFxQyxFQUNyQywwSEFBMEgsQ0FDM0g7S0FDQSxNQUFNLENBQ0wsWUFBWSxFQUNaLGlLQUFpSyxDQUNsSztLQUNBLE1BQU0sQ0FDTCxhQUFhLEVBQ2Isa0pBQWtKLENBQ25KO0tBQ0EsTUFBTSxDQUFDLHFCQUFxQixFQUFFLGtEQUFrRCxDQUFDO0tBQ2pGLE1BQU0sQ0FBQyxxQkFBcUIsRUFBRSx1Q0FBdUMsRUFBRSxVQUFVLENBQUM7S0FDbEYsTUFBTSxDQUNMLDhCQUE4QixFQUM5Qiw0RUFBNEUsRUFDNUUsVUFBVSxDQUNYO0tBQ0EsTUFBTSxDQUNMLDZCQUE2QixFQUM3Qiw4R0FBOEcsQ0FDL0c7S0FDQSxNQUFNLENBQ0wsc0JBQXNCLEVBQ3RCLG1LQUFtSyxDQUNwSyxDQUFDO0FBRUosVUFBVSxDQUFDLHdCQUF3QixFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBRTlDLHVCQUF1QjtBQUN2QixPQUFPO0tBQ0osTUFBTSxDQUNMLG9CQUFvQixFQUNwQixnSEFBZ0gsQ0FDakg7S0FDQSxNQUFNLENBQ0wsd0NBQXdDLEVBQ3hDLHlLQUF5SyxDQUMxSztLQUNBLE1BQU0sQ0FBQyxtQkFBbUIsRUFBRSwrREFBK0QsQ0FBQztLQUM1RixNQUFNLENBQ0wsaUNBQWlDLEVBQ2pDLHNGQUFzRixDQUN2RjtLQUNBLE1BQU0sQ0FDTCx1Q0FBdUMsRUFDdkMsbUhBQW1ILENBQ3BIO0tBQ0EsTUFBTSxDQUNMLGtCQUFrQixFQUNsQixpT0FBaU8sQ0FDbE87S0FDQSxNQUFNLENBQ0wscUJBQXFCLEVBQ3JCLDRIQUE0SCxDQUM3SDtLQUNBLE1BQU0sQ0FDTCwrQkFBK0IsRUFDL0IsMEhBQTBILENBQzNILENBQUM7QUFFSixVQUFVLENBQUMsc0JBQXNCLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFFNUMscUJBQXFCO0FBQ3JCLE9BQU87S0FDSixNQUFNLENBQ0wsa0NBQWtDLEVBQ2xDLHdGQUF3RixDQUN6RjtLQUNBLE1BQU0sQ0FDTCw0QkFBNEIsRUFDNUIsNkpBQTZKLEVBQzdKLENBQUMsTUFBYyxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUNyRCxDQUFDO0FBRUosVUFBVSxDQUFDLDZCQUE2QixFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBRW5ELHlCQUF5QjtBQUN6QixPQUFPO0tBQ0osTUFBTSxDQUNMLDJCQUEyQixFQUMzQiwyRkFBMkYsQ0FDNUY7S0FDQSxNQUFNLENBQ0wsNEJBQTRCLEVBQzVCLDRGQUE0RixDQUM3RjtLQUNBLE1BQU0sQ0FDTCx5QkFBeUIsRUFDekIsa0VBQWtFLENBQ25FLENBQUM7QUFFSixVQUFVLENBQUMsdUJBQXVCLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFFN0MsMkJBQTJCO0FBQzNCLE9BQU87S0FDSixNQUFNLENBQ0wscUJBQXFCLEVBQ3JCLDBIQUEwSCxDQUMzSDtLQUNBLE1BQU0sQ0FDTCxzQkFBc0IsRUFDdEIscUhBQXFILENBQ3RIO0tBQ0EsTUFBTSxDQUNMLDZCQUE2QixFQUM3Qiw4SkFBOEosQ0FDL0o7S0FDQSxNQUFNLENBQ0wsZ0NBQWdDLEVBQ2hDLHdLQUF3SyxDQUN6SztLQUNBLE1BQU0sQ0FDTCxlQUFlLEVBQ2Ysa0ZBQWtGLENBQ25GO0tBQ0EsTUFBTSxDQUNMLGlCQUFpQixFQUNqQix5SEFBeUgsQ0FDMUgsQ0FBQztBQUVKLFVBQVUsQ0FBQyx3QkFBd0IsRUFBRSxPQUFPLENBQUMsQ0FBQztBQUU5QywwQkFBMEI7QUFDMUIsT0FBTztLQUNKLE1BQU0sQ0FDTCxzQkFBc0IsRUFDdEIsa0VBQWtFLENBQ25FO0tBQ0EsTUFBTSxDQUNMLHVCQUF1QixFQUN2Qix1RUFBdUUsQ0FDeEU7S0FDQSxNQUFNLENBQ0wsb0JBQW9CLEVBQ3BCLHFMQUFxTCxDQUN0TDtLQUNBLE1BQU0sQ0FDTCx3QkFBd0IsRUFDeEIsc0VBQXNFLENBQ3ZFO0tBQ0EsTUFBTSxDQUNMLFlBQVksRUFDWixxRkFBcUYsQ0FDdEY7S0FDQSxNQUFNLENBQ0wsZ0NBQWdDLEVBQ2hDLGtMQUFrTCxDQUNuTDtLQUNBLE1BQU0sQ0FBQyxvQkFBb0IsRUFBRSxtREFBbUQsRUFBRSxVQUFVLENBQUM7S0FDN0YsTUFBTSxDQUNMLDJCQUEyQixFQUMzQiw2REFBNkQsRUFDN0QsVUFBVSxDQUNYO0tBQ0EsTUFBTSxDQUNMLHlCQUF5QixFQUN6QixxRkFBcUYsQ0FDdEY7S0FDQSxNQUFNLENBQUMscUJBQXFCLEVBQUUsZ0VBQWdFLENBQUM7S0FDL0YsTUFBTSxDQUNMLGlCQUFpQixFQUNqQiw0SUFBNEksQ0FDN0ksQ0FBQztBQUVKLFVBQVUsQ0FBQyx5QkFBeUIsRUFBRSxPQUFPLENBQUMsQ0FBQztBQUUvQyxzQkFBc0I7QUFDdEIsT0FBTztLQUNKLE1BQU0sQ0FDTCwyQkFBMkIsRUFDM0IsbUdBQW1HLENBQ3BHO0tBQ0EsTUFBTSxDQUNMLGtDQUFrQyxFQUNsQyx5RUFBeUUsRUFDekUsQ0FBQyxNQUFjLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQ3RDO0tBQ0EsTUFBTSxDQUNMLG9DQUFvQyxFQUNwQyx5SUFBeUksRUFDekksQ0FBQyxNQUFjLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQ3JEO0tBQ0EsTUFBTSxDQUNMLHVDQUF1QyxFQUN2QyxrSUFBa0ksRUFDbEksVUFBVSxDQUNYO0tBQ0EsTUFBTSxDQUFDLDBCQUEwQixFQUFFLHNDQUFzQyxDQUFDO0tBQzFFLE1BQU0sQ0FDTCxnQ0FBZ0MsRUFDaEMsMkVBQTJFLENBQzVFO0tBQ0EsTUFBTSxDQUNMLGdDQUFnQyxFQUNoQywwRUFBMEUsQ0FDM0U7S0FDQSxNQUFNLENBQ0wsOEJBQThCLEVBQzlCLHFFQUFxRSxFQUNyRSxDQUFDLE1BQWMsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FDdEM7S0FDQSxNQUFNLENBQUMsK0JBQStCLEVBQUUsMkNBQTJDLENBQUM7S0FDcEYsTUFBTSxDQUNMLHFCQUFxQixFQUNyQixpTEFBaUwsRUFDakwsQ0FBQyxNQUFjLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQ3RDO0tBQ0EsTUFBTSxDQUNMLHlDQUF5QyxFQUN6QyxxRkFBcUYsQ0FDdEYsQ0FBQztBQUVKLFVBQVUsQ0FBQyxtQkFBbUIsRUFBRSxPQUFPLENBQUMsQ0FBQztBQUV6QyxvQkFBb0I7QUFDcEIsVUFBVSxDQUFDLGVBQWUsRUFBRSxPQUFPLENBQUMsQ0FBQztBQUVyQyxhQUFhO0FBQ2IsT0FBTztLQUNKLE1BQU0sQ0FDTCxzQkFBc0IsRUFDdEIscUZBQXFGLENBQ3RGO0tBQ0EsTUFBTSxDQUNMLG1CQUFtQixFQUNuQiwyRUFBMkUsQ0FDNUU7S0FDQSxNQUFNLENBQ0wsMEJBQTBCLEVBQzFCLG9GQUFvRixFQUNwRixDQUFDLE1BQWMsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FDdEM7S0FDQSxNQUFNLENBQ0wseUJBQXlCLEVBQ3pCLDhPQUE4TyxDQUMvTyxDQUFDO0FBRUosVUFBVSxDQUFDLDBCQUEwQixFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBRWhELG1EQUFtRDtBQUNuRCxPQUFPO0tBQ0osTUFBTSxDQUNMLDJDQUEyQyxFQUMzQyx5TkFBeU4sQ0FDMU47S0FDQSxNQUFNLENBQ0wsb0JBQW9CLEVBQ3BCLCtGQUErRixDQUNoRyxDQUFDO0FBRUosVUFBVSxDQUFDLDJCQUEyQixFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBRWpELE9BQU8sQ0FBQyxFQUFFLENBQUMsUUFBUSxFQUFFLEdBQUcsRUFBRTtJQUN4QixPQUFPLENBQUMsR0FBRyxDQUFDOzs7Ozs7Q0FNYixDQUFDLENBQUM7SUFDRCxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxDQUFDO0FBRUgsT0FBTyxDQUFDLEtBQUssQ0FBQyxlQUFlLENBQUMsQ0FBQztBQUUvQixTQUFTLG9CQUFvQixDQUFDLE9BQWU7SUFDM0MsT0FBTyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN2QixPQUFPLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDaEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxxQ0FBcUMsQ0FBQyxDQUFDO0lBQ3JELE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbEIsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUU7SUFDdkIsb0JBQW9CLENBQ2xCLHFFQUFxRSxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FDcEYsTUFBTSxDQUNQLEdBQUcsQ0FDTCxDQUFDO0NBQ0g7QUFFRCxJQUFJLE9BQU8sQ0FBQyxTQUFTLENBQUMsRUFBRTtJQUN0QixvQkFBb0IsQ0FBQyxtRUFBbUUsQ0FBQyxDQUFDO0NBQzNGO0FBRUQsdUJBQXVCO0FBQ3ZCLE9BQU8sQ0FBQyxFQUFFLENBQUMsUUFBUSxFQUFFLEdBQUcsRUFBRTtJQUN4QixPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxDQUFDO0FBRUgsc0VBQXNFO0FBQ3RFLHNFQUFzRTtBQUN0RSxpRUFBaUU7QUFDakUseUNBQXlDO0FBQ3pDLE1BQU0sYUFBYSxHQUFHLHdCQUFNLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzlDLE1BQU0sb0JBQW9CLEdBQUcsRUFBRSxDQUFDO0FBQ2hDLENBQUMsZUFBZSxFQUFFLFlBQVksRUFBRSw0QkFBNEIsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRTtJQUM3RSxJQUFJLE1BQU0sSUFBSSxhQUFhLEVBQUU7UUFDM0Isb0JBQW9CLENBQUMsTUFBTSxDQUFDLEdBQUcsYUFBYSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0tBQ3REO0FBQ0gsQ0FBQyxDQUFDLENBQUM7QUFFSCxrR0FBa0c7QUFDbEcsd0NBQXdDO0FBQ3hDLE1BQU0sRUFDSixJQUFJLEVBQUUsTUFBTSxHQUFHLEtBQUssRUFDcEIsVUFBVSxFQUFFLGtCQUFrQixFQUM5QixlQUFlLEVBQ2YsYUFBYSxFQUNiLElBQUksRUFDSixVQUFVLEdBQUcsYUFBYSxJQUFJLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFDdEQsbUJBQW1CLEdBQUcsZUFBZSxFQUNyQyxLQUFLLEVBQUUsT0FBTyxFQUNkLE1BQU0sRUFBRSxRQUFRLEVBQ2hCLElBQUksRUFBRSxRQUFRLEdBQUcsV0FBVyxFQUM1QixJQUFJLEdBQUcsSUFBSSxFQUNYLE9BQU8sRUFBRSxhQUFhLEVBQ3RCLFdBQVcsRUFDWCxXQUFXLEVBQUUsYUFBYSxFQUMxQixlQUFlLEVBQ2YsT0FBTyxFQUFFLFlBQVksR0FBRyxVQUFVLEVBQ2xDLFFBQVEsRUFBRSxhQUFhLEdBQUcsV0FBVyxFQUNyQyxlQUFlLEdBQUcsS0FBSyxFQUN2QixlQUFlLEdBQUcsS0FBSyxFQUN2QixNQUFNLEVBQUUsbUJBQW1CLEVBQzNCLFNBQVMsRUFDVCxZQUFZLEVBQ1osWUFBWSxFQUNaLG1CQUFtQixFQUNuQixpQkFBaUIsRUFDakIsdUJBQXVCLEVBQ3ZCLFdBQVcsRUFDWCx5QkFBeUIsRUFDekIsd0JBQXdCLEVBQ3hCLGVBQWUsRUFDZixnQkFBZ0IsRUFDaEIsY0FBYyxHQUFHLEVBQUUsRUFDbkIsZ0JBQWdCLEVBQUUsbUJBQW1CLEVBQ3JDLE9BQU8sR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUNsQixLQUFLLEVBQUUsNkJBQTZCLEVBQ3BDLGtCQUFrQixFQUFFLG1CQUFtQixFQUN2QyxJQUFJLEVBQUUsVUFBVSxHQUFHLEtBQUssRUFDeEIsVUFBVSxHQUFHLEtBQUssRUFDbEIsV0FBVyxHQUFHLEtBQUssRUFDbkIsdUJBQXVCLEdBQUcsS0FBSyxFQUMvQixVQUFVLEdBQUcsSUFBSSxFQUNqQix5QkFBeUIsR0FBRyxLQUFLLEVBQ2pDLGdCQUFnQixFQUFFLG9CQUFvQixFQUN0QyxtQkFBbUIsRUFBRSxtQkFBbUIsRUFDeEMsVUFBVSxHQUFHLEtBQUssRUFDbEIsY0FBYyxFQUFFLGlCQUFpQixFQUNqQyxjQUFjLEdBQUcsRUFBRSxFQUNuQixhQUFhLEVBQ2IsYUFBYSxFQUFFLGlCQUFpQixFQUNoQyxjQUFjLEVBQUUsa0JBQWtCO0FBQ2xDLCtDQUErQztBQUMvQyxXQUFXLEVBQUUsZUFBZSxFQUM1QixTQUFTLEVBQ1QsVUFBVSxFQUNWLGVBQWUsRUFBRSxrQkFBa0IsR0FBRyxZQUFZLEVBQ2xELE1BQU0sRUFBRSxTQUFTLEVBQ2pCLGNBQWMsRUFDZCxtQkFBbUIsRUFDbkIsMEJBQTBCLEdBQUcsSUFBSSxFQUNqQyxjQUFjLEVBQ2QsZUFBZSxFQUNmLFlBQVksRUFDWixpQkFBaUIsRUFDakIsbUJBQW1CLEVBQ25CLGFBQWEsR0FFZCxHQUFHLDhDQUFLLHdCQUFNLENBQUMsU0FBUyxDQUFDLEdBQUssT0FBTyxHQUFLLG9CQUFvQixDQUFvQixDQUFDO0FBRXBGLE1BQU0sY0FBYyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUU7SUFDNUIsUUFBUSxHQUFHLEVBQUU7UUFDWCxLQUFLLFFBQVEsQ0FBQztRQUNkLEtBQUssSUFBSTtZQUNQLE9BQU8sSUFBSSxDQUFDO1FBQ2QsS0FBSyxJQUFJLENBQUM7UUFDVixLQUFLLFNBQVM7WUFDWixPQUFPLFNBQVMsQ0FBQztRQUNuQixLQUFLLE1BQU07WUFDVCxPQUFPLE1BQU0sQ0FBQztRQUNoQixPQUFPLENBQUMsQ0FBQztZQUNQLG9CQUFvQixDQUNsQix5RkFBeUYsQ0FDMUYsQ0FBQztTQUNIO0tBQ0Y7QUFDSCxDQUFDLENBQUMsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO0FBRXRCLElBQUksWUFBWSxJQUFJLENBQUMsZUFBZSxJQUFJLENBQUMsZUFBZSxFQUFFO0lBQ3hELG9CQUFvQixDQUFDLHlFQUF5RSxDQUFDLENBQUM7Q0FDakc7QUFFRCxJQUFJLGVBQStDLENBQUM7QUFDcEQsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLE1BQU0sRUFBRSxZQUFZLENBQUMsQ0FBQyxRQUFRLENBQUMsa0JBQWtCLENBQUMsRUFBRTtJQUNoRSxvQkFBb0IsQ0FDbEIseUdBQXlHLGtCQUFrQixHQUFHLENBQy9ILENBQUM7Q0FDSDtLQUFNO0lBQ0wsZUFBZSxHQUFHLGtCQUFrQixDQUFDO0NBQ3RDO0FBRUQsK0JBQStCO0FBQy9CO0FBQ0UsZ0JBQWdCO0FBQ2hCLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUM7SUFDMUIsdUJBQXVCO0lBQ3ZCLENBQUMsVUFBVSxDQUFDLE1BQU07UUFDaEIsbUNBQW1DO1FBQ25DLFVBQVUsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQ3REO0lBQ0Esb0JBQW9CLENBQ2xCLHNHQUFzRyxVQUFVLEdBQUcsQ0FDcEgsQ0FBQztDQUNIO0FBRUQsSUFBSSxtQkFBbUIsS0FBSyxlQUFlLElBQUksbUJBQW1CLEtBQUssS0FBSyxFQUFFO0lBQzVFLG9CQUFvQixDQUNsQixrR0FBa0csbUJBQW1CLEdBQUcsQ0FDekgsQ0FBQztDQUNIO0FBRUQsTUFBTSxRQUFRLEdBQUcsQ0FBQyxTQUFTLENBQUM7QUFFNUIsMkVBQTJFO0FBQzNFLDBFQUEwRTtBQUMxRSwwQkFBMEI7QUFDMUIsTUFBTSxPQUFPLEdBQWtCLFFBQVEsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDO0FBRXJGLE1BQU0scUJBQXFCLEdBQUcsZUFBZSxJQUFJLGtCQUFrQixJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDO0FBRWhHLDZFQUE2RTtBQUM3RSxNQUFNLE1BQU0sR0FBRyxDQUFDLENBQTZDLEVBQWMsRUFBRTtJQUMzRSxNQUFNLElBQUksR0FDUixPQUFPLENBQUMsQ0FBQyxJQUFJLEtBQUssUUFBUTtRQUN4QixDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUk7UUFDUixDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxLQUFLLFFBQVE7WUFDNUIsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQztZQUN0QixDQUFDLENBQUMsU0FBUyxDQUFDO0lBQ2hCLHVDQUNLLENBQUMsS0FDSixnQkFBZ0IsRUFBRSxDQUFDLENBQUMsa0JBQWtCLENBQUMsSUFBSSxTQUFTLEVBQ3BELEdBQUcsRUFDRCxDQUFDLENBQUMsR0FBRyxJQUFJLElBQUk7WUFDWCxDQUFDLENBQUMsU0FBUztZQUNYLENBQUMsQ0FBRSxDQUFDLENBQUMsR0FBVyxDQUFDLGtCQUFrQixJQUFJLElBQUk7Z0JBQzNDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUc7Z0JBQ1QsQ0FBQyxDQUFFLENBQUMsQ0FBQyxHQUFXLEVBQ3BCLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxJQUFJLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxTQUFTLEVBQ3JELFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQyxRQUFRLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLEVBQ2pFLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQyxRQUFRLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLEVBQ2pFLElBQUksRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFNBQVMsRUFDOUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDLElBQUksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFNBQVMsSUFDckQ7QUFDSixDQUFDLENBQUM7QUFFRiw4QkFBOEI7QUFDOUIsTUFBTSxRQUFRLG1DQUtULENBQUMsa0JBQWtCLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFZLElBQUksTUFBTTtJQUMxRCxDQUFDLENBQUMsTUFBTSxDQUFDLDRCQUF1QixDQUFDLGtCQUFrQixJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxJQUFJLFdBQVcsQ0FBQyxDQUFDO0lBQ2hHLENBQUMsQ0FBQztRQUNFLElBQUksRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsSUFBSSxXQUFXO1FBQ2pFLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLElBQUk7UUFDNUUsUUFBUSxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVTtRQUNoQyxJQUFJLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNO1FBQ3hCLFFBQVEsRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVU7S0FDakMsQ0FBQztJQUNOLHVDQUF1QztJQUN2QyxHQUFHLEVBQUUsV0FBVyxHQUNqQixDQUFDO0FBRUYsTUFBTSxXQUFXLEdBQUcsQ0FBQyxRQUFlLEVBQUUsRUFBRTtJQUN0QyxJQUFJLENBQUMsUUFBUSxFQUFFO1FBQ2IsT0FBTyxTQUFTLENBQUM7S0FDbEI7SUFDRCxNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDL0UsT0FBTyxLQUFLLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFO1FBQ3pCLElBQUksT0FBTyxPQUFPLEtBQUssVUFBVSxFQUFFO1lBQ2pDLE9BQU8sT0FBTyxDQUFDO1NBQ2hCO1FBQ0QsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQzdCLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDOUIsSUFDRSxPQUFPLENBQUMsUUFBUSxLQUFLLE9BQU87WUFDNUIsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sS0FBSyxDQUFDO1lBQ3JCLFVBQVUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3pCLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFDN0I7WUFDQSxpRkFBaUY7WUFDakYsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ2xDLHdDQUF3QztZQUN4QyxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsR0FBRyxXQUFXLElBQUksS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7U0FDekM7UUFDRCxJQUFJLElBQUksQ0FBQztRQUNULElBQUk7WUFDRixJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQyxDQUFDO1NBQ3ZDO1FBQUMsT0FBTyxDQUFDLEVBQUU7WUFDVixzQ0FBc0M7WUFDdEMsT0FBTyxDQUFDLEtBQUssQ0FBQywwQkFBMEIsSUFBSSxHQUFHLENBQUMsQ0FBQztZQUNqRCxNQUFNLENBQUMsQ0FBQztTQUNUO1FBQ0QsSUFBSSxNQUFNLEdBQUcsSUFBSSxDQUFDO1FBQ2xCLElBQUksSUFBbUIsQ0FBQztRQUN4QixPQUFPLENBQUMsSUFBSSxHQUFHLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQyxFQUFFO1lBQzdCLE1BQU0sR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDdEIsSUFBSSxNQUFNLElBQUksSUFBSSxFQUFFO2dCQUNsQixNQUFNLElBQUksS0FBSyxDQUFDLGtDQUFrQyxJQUFJLGtCQUFrQixJQUFJLEdBQUcsQ0FBQyxDQUFDO2FBQ2xGO1NBQ0Y7UUFDRCxJQUFJLE9BQU8sTUFBTSxLQUFLLFVBQVUsRUFBRTtZQUNoQyxPQUFPLE1BQU0sQ0FBQztTQUNmO2FBQU0sSUFBSSxNQUFNLEtBQUssSUFBSSxJQUFJLE9BQU8sTUFBTSxDQUFDLE9BQU8sS0FBSyxVQUFVLEVBQUU7WUFDbEUsT0FBTyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsaUJBQWlCO1NBQ3pDO2FBQU07WUFDTCxNQUFNLElBQUksS0FBSyxDQUNiLGtDQUFrQyxJQUFJLGlDQUFpQyxPQUFPLE1BQU0sR0FBRyxDQUN4RixDQUFDO1NBQ0g7SUFDSCxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQztBQUVGLElBQUksWUFBWSxJQUFJLElBQUksSUFBSSxpQkFBaUIsSUFBSSxJQUFJLEVBQUU7SUFDckQsb0JBQW9CLENBQ2xCLDhFQUE4RSxDQUMvRSxDQUFDO0NBQ0g7QUFFRCxTQUFTLFNBQVMsQ0FBQyxHQUF3QjtJQUN6QyxPQUFPLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEdBQUcsRUFBRSxFQUFFO1FBQzNDLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLElBQUksRUFBRTtZQUNwQixJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1NBQ3RCO1FBQ0QsT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDVCxDQUFDO0FBRUQsSUFDRSxtQkFBbUI7SUFDbkIsQ0FBQyxtQkFBbUI7UUFDbEIsaUJBQWlCO1FBQ2pCLHVCQUF1QjtRQUN2QixXQUFXO1FBQ1gseUJBQXlCO1FBQ3pCLHdCQUF3QjtRQUN4QixlQUFlO1FBQ2YsZ0JBQWdCLENBQUMsRUFDbkI7SUFDQSxvQkFBb0IsQ0FDbEIsbUhBQW1ILENBQ3BILENBQUM7Q0FDSDtBQUNELE1BQU0sZ0JBQWdCLEdBQXNCLG1CQUFtQjtJQUM3RCxDQUFDLENBQUMsbUJBQW1CO0lBQ3JCLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDUixVQUFVLEVBQUUsbUJBQW1CO1FBQy9CLFFBQVEsRUFBRSxpQkFBaUI7UUFDM0IsY0FBYyxFQUFFLHVCQUF1QjtRQUN2QyxLQUFLLEVBQUUsV0FBVztRQUNsQixnQkFBZ0IsRUFBRSx5QkFBeUI7UUFDM0MsZUFBZSxFQUFFLHdCQUF3QjtRQUN6QyxNQUFNLEVBQUUsZUFBZTtRQUN2QixPQUFPLEVBQUUsZ0JBQWdCO0tBQzFCLENBQUMsQ0FBQztBQUVQLE1BQU0sYUFBYSxHQUFHLFdBQVcsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO0FBQ3JELE1BQU0sY0FBYyxHQUFHLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBQ3ZELE1BQU0sV0FBVyxHQUFHLFdBQVcsQ0FBQyxlQUFlLENBQUMsQ0FBQztBQUVqRCx1RUFBdUU7QUFDdkUsTUFBTSxtQkFBbUIsR0FBRyxVQUFVLENBQ3BDLHFCQUFxQixrQ0FFaEIsd0JBQU0sQ0FBQyxTQUFTLENBQUMsS0FDcEIsVUFBVTtJQUNWLFdBQVc7SUFDWCx1QkFBdUIsRUFDdkIsVUFBVSxFQUFFLFVBQVUsRUFDdEIseUJBQXlCO0lBQ3pCLFlBQVk7SUFDWixhQUFhLEVBQ2IsUUFBUSxFQUFFLENBQUMsZUFBZSxFQUMxQixlQUFlLEVBQUUsZUFBZSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFNBQVMsRUFDbkQsbUJBQW1CLEVBQUUsbUJBQW1CLElBQUksNkJBQTZCLEVBQ3pFLFNBQVMsRUFBRSxTQUFTLElBQUksbUJBQW1CLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxVQUFVLEVBQ3JFLFlBQVk7SUFDWixZQUFZO0lBQ1osY0FBYztJQUNkLE9BQU87SUFDUCxnQkFBZ0I7SUFDaEIsZUFBZTtJQUNmLGFBQWEsRUFDYixhQUFhLEVBQUUsYUFBYSxJQUFJLElBQUksRUFDcEMsVUFBVTtJQUNWLG1CQUFtQjtJQUNuQixJQUFJO0lBQ0osT0FBTztJQUNQLGNBQWM7SUFDZCxjQUFjO0lBQ2QsZUFBZSxFQUNmLFlBQVksRUFBRSxZQUFZLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsU0FBUyxFQUM3QyxVQUFVO0lBQ1Ysb0JBQW9CO0lBQ3BCLG1CQUFtQjtJQUNuQixVQUFVO0lBQ1YsYUFBYSxFQUNiLGFBQWEsRUFBRSxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUMsZUFBZSxFQUFFLEdBQUcsQ0FBQyxhQUFhLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsYUFBYSxFQUM1RixjQUFjO0lBQ2QsV0FBVztJQUNYLFNBQVM7SUFDVCxVQUFVO0lBQ1YsZUFBZTtJQUNmLDBCQUEwQjtJQUMxQixjQUFjO0lBQ2QsbUJBQW1CO0lBQ25CLFVBQVU7SUFDVixpQkFBaUI7SUFDakIsbUJBQW1CO0lBQ25CLGFBQWE7SUFDYixxQkFBcUIsS0FFdkIsRUFBRSxNQUFNLEVBQU4sd0JBQU0sRUFBRSxVQUFVLEVBQUUsT0FBTyxFQUFFLENBQ2hDLENBQUM7QUFFRixTQUFTLGNBQWMsQ0FBQyxNQUFNLEdBQUcsU0FBUztJQUN4QyxLQUFLLE1BQU0sRUFBRSxJQUFJLE9BQU8sQ0FBQyxPQUFPLEVBQUU7UUFDaEMsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNuQyxJQUFJLE1BQU0sQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxJQUFJLE1BQU0sRUFBRTtZQUN2RSxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1NBQ3JCO0tBQ0Y7QUFDSCxDQUFDO0FBRUQsSUFBSSxRQUFRLEVBQUU7SUFDWiw4REFBOEQ7SUFDOUQsQ0FBQyxLQUFLLElBQW1CLEVBQUU7UUFDekIsTUFBTSxNQUFNLEdBQUcsSUFBSSxTQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDbEMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxPQUFPLEVBQUUsR0FBRyxDQUFDLEVBQUU7WUFDdkIsc0NBQXNDO1lBQ3RDLE9BQU8sQ0FBQyxLQUFLLENBQUMscUNBQXFDLEVBQUUsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ3BFLENBQUMsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxFQUFFLGdCQUFnQixFQUFFLEdBQUcsMkNBQTRCLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRSxtQkFBbUIsQ0FBQyxDQUFDO1FBQ2hHLE1BQU0sZ0JBQWdCLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsT0FBTyxFQUFFO1lBQ1osTUFBTSxNQUFNLENBQUMsR0FBRyxFQUFFLENBQUM7U0FDcEI7SUFDSCxDQUFDLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLEVBQUU7UUFDbEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQ2pDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDakIsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNsQixDQUFDLENBQUMsQ0FBQztDQUNKO0tBQU07SUFDTCxJQUFJLGNBQWMsSUFBSSxDQUFDLElBQUksT0FBTyxDQUFDLFFBQVEsRUFBRTtRQUMzQyxJQUFJLFlBQVksR0FBRyxLQUFLLENBQUM7UUFDekIsTUFBTSxRQUFRLEdBQUcsR0FBRyxFQUFFO1lBQ3BCLElBQUksQ0FBQyxZQUFZLEVBQUU7Z0JBQ2pCLFlBQVksR0FBRyxJQUFJLENBQUM7Z0JBQ3BCLE9BQU8sQ0FBQyxRQUFRLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixNQUFNLGVBQWUsR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFO29CQUN0QyxNQUFNLGNBQWMsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQyxNQUFNLENBQUM7b0JBQzNELElBQUksY0FBYyxHQUFHLENBQUMsRUFBRTt3QkFDdEIsT0FBTyxDQUFDLEdBQUcsQ0FDVCxlQUFlLGNBQWMsbURBQW1ELENBQ2pGLENBQUM7d0JBQ0YsY0FBYyxDQUFDLFNBQVMsQ0FBQyxDQUFDO3dCQUMxQixNQUFNLG9CQUFvQixHQUFHLFVBQVUsQ0FBQyxHQUFHLEVBQUU7NEJBQzNDLE9BQU8sQ0FBQyxHQUFHLENBQ1QsNEVBQTRFLENBQzdFLENBQUM7NEJBQ0YsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQzt3QkFDbEIsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO3dCQUNULG9CQUFvQixDQUFDLEtBQUssRUFBRSxDQUFDO3FCQUM5Qjt5QkFBTTt3QkFDTCxPQUFPLENBQUMsR0FBRyxDQUFDLHFFQUFxRSxDQUFDLENBQUM7d0JBQ25GLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7cUJBQ2pCO2dCQUNILENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztnQkFDVCxlQUFlLENBQUMsS0FBSyxFQUFFLENBQUM7Z0JBQ3hCLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0RBQWdELENBQUMsQ0FBQztnQkFDOUQsY0FBYyxDQUFDLFNBQVMsQ0FBQyxDQUFDO2FBQzNCO1FBQ0gsQ0FBQyxDQUFDO1FBRUYsT0FBTyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxFQUFFO1lBQzFDLE9BQU8sQ0FBQyxHQUFHLENBQ1QsMEJBQTBCLE1BQU0sQ0FBQyxPQUFPLENBQUMsR0FBRyxpQkFBaUIsSUFBSSxZQUFZLE1BQU0sR0FBRyxDQUN2RixDQUFDO1lBQ0YsUUFBUSxFQUFFLENBQUM7UUFDYixDQUFDLENBQUMsQ0FBQztRQUVILEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxjQUFjLEVBQUUsQ0FBQyxFQUFFLEVBQUU7WUFDdkMsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQztnQkFDMUIsMEJBQTBCLEVBQUUsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7YUFDMUMsQ0FBQyxDQUFDO1lBQ0gsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4QkFBOEIsQ0FBQyxHQUFHLENBQUMsU0FBUyxNQUFNLENBQUMsT0FBTyxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUM7U0FDaEY7S0FDRjtTQUFNO1FBQ0wsbUNBQW1DO1FBQ25DLE1BQU0sYUFBYSxHQUFHLHNCQUFZLENBQUMsUUFBUSxFQUFFLE9BQU8sRUFBRSxtQkFBbUIsQ0FBQyxDQUFDO1FBRTNFLHFEQUFxRDtRQUNyRCx5RUFBeUU7UUFDekUsMEJBQTBCO1FBQzFCLE1BQU0sVUFBVSxHQUFHLFVBQVU7UUFDM0IsbUJBQW1CLENBQUMsdUJBQXVCLENBQUMsbUJBQW1CLEVBQy9ELGFBQWEsRUFDYjtZQUNFLE9BQU8sRUFBRSxtQkFBbUI7U0FDN0IsQ0FDRixDQUFDO1FBRUYsTUFBTSxNQUFNLEdBQUcsbUJBQVksQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUN4QyxJQUFJLGFBQWEsRUFBRTtZQUNqQixNQUFNLENBQUMsT0FBTyxHQUFHLGFBQWEsQ0FBQztTQUNoQztRQUVELElBQUksVUFBVSxDQUFDLE1BQU0sRUFBRTtZQUNyQiwrQ0FBK0IsQ0FBQyxNQUFNLEVBQUUsVUFBVSxDQUFDLENBQUM7U0FDckQ7UUFFRCxVQUFVLENBQUMsb0JBQW9CLEVBQUUsTUFBTSxFQUFFO1lBQ3ZDLE9BQU8sRUFBRSxtQkFBbUI7WUFDNUIsVUFBVTtTQUNYLENBQUMsQ0FBQztRQUVILDJFQUEyRTtRQUMzRSx1REFBdUQ7UUFDdkQsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRTtZQUNqQyxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDakMsTUFBTSxVQUFVLEdBQUcsT0FBTyxPQUFPLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7WUFDckUsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLFFBQVE7Z0JBQzNCLENBQUMsQ0FBQyxLQUFLO29CQUNMLENBQUMsQ0FBQyxlQUFlLE9BQU8sQ0FBQyxHQUFHLEdBQUc7b0JBQy9CLENBQUMsQ0FBQyxRQUFRO2dCQUNaLENBQUMsQ0FBQyxVQUFVLE9BQU8sQ0FBQyxHQUFHLENBQUMsMEJBQTBCLFNBQVMsT0FBTyxDQUFDLEdBQUcsR0FBRyxDQUFDO1lBQzVFLE1BQU0sYUFBYSxHQUFHLElBQUksUUFBUSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQzdDLElBQUksT0FBTyxDQUFDLFFBQVEsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLDBCQUEwQixLQUFLLEdBQUcsRUFBRTtnQkFDdEUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FDVCxnQkFBZ0IsYUFBYSxJQUFJLElBQUksc0JBQXNCLGVBQUssQ0FBQyxTQUFTLENBQ3hFLFVBQVUsQ0FBQyxRQUFRLEVBQUUsQ0FDdEIsS0FBSyxDQUNQLENBQUM7Z0JBQ0YsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDaEIsTUFBTSxFQUNKLElBQUksRUFBRSxTQUFTLEVBQ2YsSUFBSSxFQUFFLFNBQVMsRUFDZixRQUFRLEVBQUUsVUFBVSxFQUNwQixJQUFJLEVBQUUsTUFBTSxFQUNaLFFBQVEsRUFBRSxVQUFVLEdBQ3JCLEdBQUcsUUFBUSxDQUFDO2dCQUNiLGtFQUFrRTtnQkFDbEUsTUFBTSxNQUFNLEdBQUcsU0FBUyxJQUFJLFdBQVcsQ0FBQztnQkFDeEMsTUFBTSxNQUFNLEdBQUcsQ0FBQyxTQUFTLElBQUksUUFBUSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQztnQkFDdEUsTUFBTSxvQkFBb0IsR0FBRyxNQUFNO29CQUNqQyxDQUFDLENBQUMsbUJBQW1CO29CQUNyQixDQUFDLENBQUMsY0FBYyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxHQUFHLFVBQVUsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxFQUFFLEdBQ2hFLE1BQU0sSUFBSSxVQUFVLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFDL0IsR0FBRyxNQUFNLElBQUksVUFBVSxJQUFJLE1BQU0sS0FBSyxXQUFXLElBQUksTUFBTSxLQUFLLElBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEdBQ2hGLE1BQU0sS0FBSyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksUUFBUSxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFDbEQsR0FBRyxVQUFVLENBQUMsQ0FBQyxDQUFDLElBQUksVUFBVSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDO2dCQUU1QyxNQUFNLFdBQVcsR0FBa0IsVUFBVSxDQUMzQyxjQUFjLEVBQ2Q7b0JBQ0Usd0JBQXdCLGVBQUssQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FDL0MsVUFBVSxRQUFRLElBQUksVUFBVSxHQUFHLFlBQVksRUFBRSxDQUNsRCxFQUFFO3dCQUNELENBQUMsbUJBQW1CLENBQUMsYUFBYTs0QkFDaEMsQ0FBQyxDQUFDLEtBQUssbUJBQW1CLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsd0JBQXdCOzRCQUN0RSxDQUFDLENBQUMsRUFBRSxDQUFDO29CQUNULENBQUMsZUFBZTt3QkFDZCx3QkFBd0IsZUFBSyxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUMvQyxVQUFVLFFBQVEsSUFBSSxVQUFVLEdBQUcsYUFBYSxFQUFFLENBQ25ELEVBQUU7NEJBQ0QsQ0FBQyxtQkFBbUIsQ0FBQyxlQUFlO2dDQUNwQyxtQkFBbUIsQ0FBQyxJQUFJO2dDQUN4QixtQkFBbUIsQ0FBQyxhQUFhO2dDQUMvQixDQUFDLENBQUMsRUFBRTtnQ0FDSixDQUFDLENBQUMsS0FBSyxlQUFLLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLDZCQUE2QixDQUFDO29CQUN2RSx3QkFBd0IsZUFBSyxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsb0JBQW9CLENBQUMsR0FDbkUsbUJBQW1CLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQ2hELEVBQUU7b0JBQ0Ysd0JBQXdCLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxlQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFO29CQUNqRix3QkFBd0IsZUFBSyxDQUFDLFNBQVMsQ0FDckMsaURBQWlELENBQ2xELEVBQUU7b0JBQ0gsd0JBQXdCLE9BQU8sQ0FBQyxPQUFPLE9BQU8sRUFBRSxDQUFDLFFBQVEsRUFBRSxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsRUFBRTtvQkFDMUUsZ0JBQWdCLENBQUMsTUFBTSxLQUFLLENBQUM7d0JBQzNCLENBQUMsQ0FBQyxRQUFRLGVBQUssQ0FBQyxJQUFJLENBQ2hCLE9BQU8sQ0FDUiw0Q0FBNEMsZUFBSyxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUNwRSwrQkFBK0IsQ0FDaEMsRUFBRTt3QkFDTCxDQUFDLENBQUMsSUFBSTtpQkFDVCxFQUNEO29CQUNFLE9BQU8sRUFBRSxtQkFBbUI7b0JBQzVCLFVBQVU7b0JBQ1YsSUFBSSxFQUFFLFVBQVU7b0JBQ2hCLEtBQUssRUFBTCxlQUFLO2lCQUNOLENBQ0YsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQ25CLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLE9BQU8sR0FBRyxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztnQkFFN0QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7YUFDbEM7aUJBQU07Z0JBQ0wsT0FBTyxDQUFDLEdBQUcsQ0FDVCxnQkFBZ0IsYUFBYSxJQUFJLElBQUksc0JBQXNCLGVBQUssQ0FBQyxTQUFTLENBQ3hFLFVBQVUsQ0FBQyxRQUFRLEVBQUUsQ0FDdEIsS0FBSyxDQUNQLENBQUM7YUFDSDtZQUNELE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDbEIsQ0FBQyxDQUFDLENBQUM7S0FDSjtDQUNGO0FBQ0QsbUJBQW1CIn0=