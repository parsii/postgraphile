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
skipPlugins: skipPluginNames, readCache, writeCache, legacyRelations: rawLegacyRelations = 'deprecated', server: yesServer, clusterWorkers, enableQueryBatching, setofFunctionsContainNulls = true, legacyJsonUuid, disableQueryLog, allowExplain, simpleCollections, legacyFunctionsOnly, ignoreIndexes, } = { ...postgraphilerc_1.default['options'], ...program, ...overridesFromOptions };
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
    return {
        ...o,
        application_name: o['application_name'] || undefined,
        ssl: o.ssl == null
            ? undefined
            : o.ssl.rejectUnauthorized == null
                ? !!o.ssl
                : o.ssl,
        user: typeof o.user === 'string' ? o.user : undefined,
        database: typeof o.database === 'string' ? o.database : undefined,
        password: typeof o.password === 'string' ? o.password : undefined,
        port: Number.isFinite(port) ? port : undefined,
        host: typeof o.host === 'string' ? o.host : undefined,
    };
};
// Create our Postgres config.
const pgConfig = {
    // If we have a Postgres connection string, parse it and use that as our
    // config. If we don’t have a connection string use some environment
    // variables or final defaults. Other environment variables should be
    // detected and used by `pg`.
    ...(pgConnectionString || process.env.DATABASE_URL || isDemo
        ? coerce(pg_connection_string_1.parse(pgConnectionString || process.env.DATABASE_URL || DEMO_PG_URL))
        : {
            host: process.env.PGHOST || process.env.PGHOSTADDR || 'localhost',
            port: (process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : null) || 5432,
            database: process.env.PGDATABASE,
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
        }),
    // Add the max pool size to our config.
    max: maxPoolSize,
};
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
const postgraphileOptions = pluginHook('cli:library:options', {
    ...postgraphilerc_1.default['options'],
    classicIds,
    dynamicJson,
    disableDefaultMutations,
    ignoreRBAC: ignoreRbac,
    includeExtensionResources,
    graphqlRoute,
    graphiqlRoute,
    graphiql: !disableGraphiql,
    enhanceGraphiql: enhanceGraphiql ? true : undefined,
    jwtPgTypeIdentifier: jwtPgTypeIdentifier || deprecatedJwtPgTypeIdentifier,
    jwtSecret: jwtSecret || deprecatedJwtSecret || process.env.JWT_SECRET,
    jwtPublicKey,
    jwtAudiences,
    jwtSignOptions,
    jwtRole,
    jwtVerifyOptions,
    retryOnInitFail,
    pgDefaultRole,
    subscriptions: subscriptions || live,
    websockets,
    websocketOperations,
    live,
    watchPg,
    showErrorStack,
    extendedErrors,
    disableQueryLog,
    allowExplain: allowExplain ? true : undefined,
    enableCors,
    exportJsonSchemaPath,
    exportGqlSchemaPath,
    sortExport,
    bodySizeLimit,
    appendPlugins: smartTagsPlugin ? [smartTagsPlugin, ...(appendPlugins || [])] : appendPlugins,
    prependPlugins,
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
    ownerConnectionString,
}, { config: postgraphilerc_1.default, cliOptions: program });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3Bvc3RncmFwaGlsZS9jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFDQSw0QkFBNEI7O0FBRTVCOzs7Ozs7R0FNRztBQUNILHFEQUFzQztBQUV0Qyx5QkFBeUI7QUFDekIsK0JBQW9DO0FBQ3BDLGlDQUEwQjtBQUMxQixxQ0FBc0M7QUFFdEMsK0RBQXdFO0FBQ3hFLGlEQUE0RTtBQUM1RSx3Q0FBMkQ7QUFDM0QsMkJBQXNDO0FBQ3RDLG1DQUFvQztBQUNwQyw2Q0FBa0U7QUFDbEUsc0NBQXVDO0FBRXZDLGtDQUFrQztBQUNsQywrQ0FBK0M7QUFDL0Msa0NBQWtDO0FBQ2xDLGdEQUFpRDtBQUNqRCx3REFBdUU7QUFDdkUsMkJBQWdDO0FBRWhDLE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRywwQkFBMEIsQ0FBQztBQUM1RDs7O0dBR0c7QUFDSCxNQUFNLGVBQWUsR0FBRyxlQUFVLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLHVDQUE2QixFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUV0RixNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixLQUFLLGFBQWEsQ0FBQztBQUU3RCxTQUFTLFFBQVEsQ0FBQyxHQUFZO0lBQzVCLE9BQU8sT0FBTyxHQUFHLEtBQUssUUFBUSxDQUFDO0FBQ2pDLENBQUM7QUFFRCxNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFFdEUsTUFBTSxRQUFRLEdBQUcsWUFBWSxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFFbEQsK0JBQStCO0FBQy9CLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQztBQUV6QixTQUFTLGNBQWMsQ0FDckIsT0FBc0I7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