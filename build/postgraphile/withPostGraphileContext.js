"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.debugPgClient = void 0;
const tslib_1 = require("tslib");
const createDebugger = require("debug");
const jwt = require("jsonwebtoken");
const graphql_1 = require("graphql");
const sql = require("pg-sql2");
const pgClientFromContext_1 = require("../postgres/inventory/pgClientFromContext");
const pluginHook_1 = require("./pluginHook");
const postgraphile_core_1 = require("postgraphile-core");
const undefinedIfEmpty = (o) => o && (!Array.isArray(o) || o.length) ? o : undefined;
const debugPg = createDebugger('postgraphile:postgres');
const debugPgError = createDebugger('postgraphile:postgres:error');
const debugPgNotice = createDebugger('postgraphile:postgres:notice');
/**
 * Formats an error/notice from `pg` and feeds it into a `debug` function.
 */
function debugPgErrorObject(debugFn, object) {
    debugFn('%s%s: %s%s%s', object.severity || 'ERROR', object.code ? `[${object.code}]` : '', object.message || object, object.where ? ` | WHERE: ${object.where}` : '', object.hint ? ` | HINT: ${object.hint}` : '');
}
const simpleWithPgClientCache = new WeakMap();
function simpleWithPgClient(pgPool) {
    const cached = simpleWithPgClientCache.get(pgPool);
    if (cached) {
        return cached;
    }
    const func = async (cb) => {
        const pgClient = await pgPool.connect();
        try {
            return await cb(pgClient);
        }
        finally {
            pgClient.release();
        }
    };
    simpleWithPgClientCache.set(pgPool, func);
    return func;
}
const withDefaultPostGraphileContext = async (options, callback) => {
    const { pgPool, jwtToken, jwtSecret, jwtPublicKey, jwtAudiences, jwtRole = ['role'], jwtVerifyOptions, pgDefaultRole, pgSettings, explain, queryDocumentAst, operationName, pgForceTransaction, singleStatement, transactionIsolationLevel } = options;
    let operation;
    if (!pgForceTransaction && queryDocumentAst) {
        // tslint:disable-next-line
        for (let i = 0, l = queryDocumentAst.definitions.length; i < l; i++) {
            const definition = queryDocumentAst.definitions[i];
            if (definition.kind === graphql_1.Kind.OPERATION_DEFINITION) {
                if (!operationName && operation) {
                    throw new Error('Multiple operations present in GraphQL query, you must specify an `operationName` so we know which one to execute.');
                }
                else if (!operationName || (definition.name && definition.name.value === operationName)) {
                    operation = definition;
                }
            }
        }
    }
    // Warning: this is only set if pgForceTransaction is falsy
    const operationType = operation != null ? operation.operation : null;
    const { role: pgRole, localSettings, jwtClaims } = await getSettingsForPgClientTransaction({
        jwtToken,
        jwtSecret,
        jwtPublicKey,
        jwtAudiences,
        jwtRole,
        jwtVerifyOptions,
        pgDefaultRole,
        pgSettings,
    });
    const sqlSettings = [];
    if (localSettings.length > 0) {
        // Later settings should win, so we're going to loop backwards and not
        // add settings for keys we've already seen.
        const seenKeys = [];
        // TODO:perf: looping backwards is slow
        for (let i = localSettings.length - 1; i >= 0; i--) {
            const [key, value] = localSettings[i];
            if (!seenKeys.includes(key)) {
                seenKeys.push(key);
                // Make sure that the third config is always `true` so that we are only
                // ever setting variables on the transaction.
                // Also, we're using `unshift` to undo the reverse-looping we're doing
                sqlSettings.unshift(sql.fragment `set_config(${sql.value(key)}, ${sql.value(value)}, true)`);
            }
        }
    }
    const sqlSettingsQuery = sqlSettings.length > 0 ? sql.compile(sql.query `select ${sql.join(sqlSettings, ', ')}`) : null;
    // If we can avoid transactions, we get greater performance.
    const needTransaction = pgForceTransaction ||
        !!sqlSettingsQuery ||
        (operationType !== 'query' && operationType !== 'subscription');
    // Now we've caught as many errors as we can at this stage, let's create a DB connection.
    const withAuthenticatedPgClient = !needTransaction
        ? simpleWithPgClient(pgPool)
        : async (cb) => {
            // Connect a new Postgres client
            const pgClient = await pgPool.connect();
            const getBeginQuery = () => {
                if (!transactionIsolationLevel)
                    return 'begin';
                return `begin transaction isolation level ${transactionIsolationLevel}`;
            };
            console.log('beginning transaction with cmd:', getBeginQuery());
            // Begin our transaction
            await pgClient.query(getBeginQuery());
            try {
                // If there is at least one local setting, load it into the database.
                if (sqlSettingsQuery) {
                    await pgClient.query(sqlSettingsQuery);
                }
                // Use the client, wait for it to be finished with, then go to 'finally'
                return await cb(pgClient);
            }
            finally {
                // Cleanup our Postgres client by ending the transaction and releasing
                // the client back to the pool. Always do this even if the query fails.
                try {
                    await pgClient.query('commit');
                }
                finally {
                    pgClient.release();
                }
            }
        };
    if (singleStatement) {
        // TODO:v5: remove this workaround
        /*
         * This is a workaround for subscriptions; the GraphQL context is allocated
         * for the entire duration of the subscription, however hogging a pgClient
         * for more than a few milliseconds (let alone hours!) is a no-no. So we
         * fake a PG client that will set up the transaction each time `query` is
         * called. It's a very thin/dumb wrapper, so it supports nothing but
         * `query`.
         */
        const fakePgClient = {
            query(textOrQueryOptions, values, // tslint:disable-line no-any
            cb) {
                if (!textOrQueryOptions) {
                    throw new Error('Incompatible call to singleStatement - no statement passed?');
                }
                else if (typeof textOrQueryOptions === 'object') {
                    if (values || cb) {
                        throw new Error('Incompatible call to singleStatement - expected no callback');
                    }
                }
                else if (typeof textOrQueryOptions !== 'string') {
                    throw new Error('Incompatible call to singleStatement - bad query');
                }
                else if (values && !Array.isArray(values)) {
                    throw new Error('Incompatible call to singleStatement - bad values');
                }
                else if (cb) {
                    throw new Error('Incompatible call to singleStatement - expected to return promise');
                }
                // Generate an authenticated client on the fly
                return withAuthenticatedPgClient(pgClient => pgClient.query(textOrQueryOptions, values));
            },
        }; // tslint:disable-line no-any
        return callback({
            [pgClientFromContext_1.$$pgClient]: fakePgClient,
            pgRole,
            jwtClaims,
        });
    }
    else {
        return withAuthenticatedPgClient(async (pgClient) => {
            let results = null;
            if (explain) {
                pgClient.startExplain();
            }
            try {
                return await callback(Object.assign({ [pgClientFromContext_1.$$pgClient]: pgClient, pgRole,
                    jwtClaims }, (explain
                    ? {
                        getExplainResults: () => {
                            results = results || pgClient.stopExplain();
                            return results;
                        },
                    }
                    : null)));
            }
            finally {
                if (explain) {
                    results = results || pgClient.stopExplain();
                }
            }
        });
    }
};
/**
 * Creates a PostGraphile context object which should be passed into a GraphQL
 * execution. This function will also connect a client from a Postgres pool and
 * setup a transaction in that client.
 *
 * This function is intended to wrap a call to GraphQL-js execution like so:
 *
 * ```js
 * const result = await withPostGraphileContext({
 *   pgPool,
 *   jwtToken,
 *   jwtSecret,
 *   pgDefaultRole,
 * }, async context => {
 *   return await graphql(
 *     schema,
 *     query,
 *     null,
 *     { ...context },
 *     variables,
 *     operationName,
 *   );
 * });
 * ```
 */
const withPostGraphileContext = async (options, callback) => {
    const pluginHook = pluginHook_1.pluginHookFromOptions(options);
    const withContext = pluginHook('withPostGraphileContext', withDefaultPostGraphileContext, {
        options,
    });
    return withContext(options, callback);
};
exports.default = withPostGraphileContext;
/**
 * Sets up the Postgres client transaction by decoding the JSON web token and
 * doing some other cool things.
 */
// THIS METHOD SHOULD NEVER RETURN EARLY. If this method returns early then it
// may skip the super important step of setting the role on the Postgres
// client. If this happens it’s a huge security vulnerability. Never using the
// keyword `return` in this function is a good first step. You can still throw
// errors, however, as this will stop the request execution.
async function getSettingsForPgClientTransaction({ jwtToken, jwtSecret, jwtPublicKey, jwtAudiences, jwtRole, jwtVerifyOptions, pgDefaultRole, pgSettings, }) {
    // Setup our default role. Once we decode our token, the role may change.
    let role = pgDefaultRole;
    let jwtClaims = {};
    // If we were provided a JWT token, let us try to verify it. If verification
    // fails we want to throw an error.
    if (jwtToken) {
        // Try to run `jwt.verify`. If it fails, capture the error and re-throw it
        // as a 403 error because the token is not trustworthy.
        try {
            const jwtVerificationSecret = jwtPublicKey || jwtSecret;
            // If a JWT token was defined, but a secret was not provided to the server or
            // secret had unsupported type, throw a 403 error.
            if (!Buffer.isBuffer(jwtVerificationSecret) &&
                typeof jwtVerificationSecret !== 'string' &&
                typeof jwtVerificationSecret !== 'function') {
                // tslint:disable-next-line no-console
                console.error(`ERROR: '${jwtPublicKey ? 'jwtPublicKey' : 'jwtSecret'}' was not set to a string or buffer - rejecting JWT-authenticated request.`);
                throw new Error('Not allowed to provide a JWT token.');
            }
            if (jwtAudiences != null && jwtVerifyOptions && 'audience' in jwtVerifyOptions)
                throw new Error(`Provide either 'jwtAudiences' or 'jwtVerifyOptions.audience' but not both`);
            const claims = await new Promise((resolve, reject) => {
                jwt.verify(jwtToken, jwtVerificationSecret, Object.assign(Object.assign({}, jwtVerifyOptions), { audience: jwtAudiences ||
                        (jwtVerifyOptions && 'audience' in jwtVerifyOptions
                            ? undefinedIfEmpty(jwtVerifyOptions.audience)
                            : ['postgraphile']) }), (err, decoded) => {
                    if (err)
                        reject(err);
                    else
                        resolve(decoded);
                });
            });
            if (typeof claims === 'string') {
                throw new Error('Invalid JWT payload');
            }
            // jwt.verify returns `object | string`; but the `object` part is really a map
            jwtClaims = claims;
            const roleClaim = getPath(jwtClaims, jwtRole);
            // If there is a `role` property in the claims, use that instead of our
            // default role.
            if (typeof roleClaim !== 'undefined') {
                if (typeof roleClaim !== 'string')
                    throw new Error(`JWT \`role\` claim must be a string. Instead found '${typeof jwtClaims['role']}'.`);
                role = roleClaim;
            }
        }
        catch (error) {
            // In case this error is thrown in an HTTP context, we want to add status code
            // Note. jwt.verify will add a name key to its errors. (https://github.com/auth0/node-jsonwebtoken#errors--codes)
            error.statusCode =
                'name' in error && error.name === 'TokenExpiredError'
                    ? // The correct status code for an expired ( but otherwise acceptable token is 401 )
                        401
                    : // All other authentication errors should get a 403 status code.
                        403;
            throw error;
        }
    }
    // Instantiate a map of local settings. This map will be transformed into a
    // Sql query.
    const localSettings = [];
    // Set the custom provided settings before jwt claims and role are set
    // this prevents an accidentional overwriting
    if (pgSettings && typeof pgSettings === 'object') {
        for (const key in pgSettings) {
            if (Object.prototype.hasOwnProperty.call(pgSettings, key) &&
                isPgSettingValid(pgSettings[key])) {
                if (key === 'role') {
                    role = String(pgSettings[key]);
                }
                else {
                    localSettings.push([key, String(pgSettings[key])]);
                }
            }
        }
    }
    // If there is a rule, we want to set the root `role` setting locally
    // to be our role. The role may only be null if we have no default role.
    if (typeof role === 'string') {
        localSettings.push(['role', role]);
    }
    // If we have some JWT claims, we want to set those claims as local
    // settings with the namespace `jwt.claims`.
    for (const key in jwtClaims) {
        if (Object.prototype.hasOwnProperty.call(jwtClaims, key)) {
            const rawValue = jwtClaims[key];
            // Unsafe to pass raw object/array to pg.query -> set_config; instead JSONify
            const value = rawValue != null && typeof rawValue === 'object' ? JSON.stringify(rawValue) : rawValue;
            if (isPgSettingValid(value)) {
                localSettings.push([`jwt.claims.${key}`, String(value)]);
            }
        }
    }
    return {
        localSettings,
        role,
        jwtClaims: jwtToken ? jwtClaims : null,
    };
}
const $$pgClientOrigQuery = Symbol();
/**
 * Monkey-patches the `query` method of a pg Client to add debugging
 * functionality. Use with care.
 */
function debugPgClient(pgClient, allowExplain = false) {
    // If Postgres debugging is enabled, enhance our query function by adding
    // a debug statement.
    if (!pgClient[$$pgClientOrigQuery]) {
        // Set the original query method to a key on our client. If that key is
        // already set, use that.
        pgClient[$$pgClientOrigQuery] = pgClient.query;
        pgClient.startExplain = () => {
            pgClient._explainResults = [];
        };
        pgClient.stopExplain = async () => {
            const results = pgClient._explainResults;
            pgClient._explainResults = null;
            if (!results) {
                return Promise.resolve([]);
            }
            return (await Promise.all(results.map(async (r) => {
                const { result: resultPromise } = r, rest = tslib_1.__rest(r, ["result"]);
                const result = await resultPromise;
                const firstKey = result && result[0] && Object.keys(result[0])[0];
                if (!firstKey) {
                    return null;
                }
                const plan = result.map((r) => r[firstKey]).join('\n');
                return Object.assign(Object.assign({}, rest), { plan });
            }))).filter((entry) => !!entry);
        };
        if (debugPgNotice.enabled) {
            pgClient.on('notice', (msg) => {
                debugPgErrorObject(debugPgNotice, msg);
            });
        }
        const logError = (error) => {
            if (error.name && error['severity']) {
                debugPgErrorObject(debugPgError, error);
            }
            else {
                debugPgError('%O', error);
            }
        };
        if (debugPg.enabled || debugPgNotice.enabled || allowExplain) {
            // tslint:disable-next-line only-arrow-functions
            pgClient.query = function (...args) {
                const [a, b, c] = args;
                // If we understand it (and it uses the promises API)
                if ((typeof a === 'string' && !c && (!b || Array.isArray(b))) ||
                    (typeof a === 'object' && !b && !c)) {
                    if (debugPg.enabled) {
                        // Debug just the query text. We don’t want to debug variables because
                        // there may be passwords in there.
                        debugPg('%s', postgraphile_core_1.formatSQLForDebugging(a && a.text ? a.text : a));
                    }
                    if (pgClient._explainResults) {
                        const query = a && a.text ? a.text : a;
                        const values = a && a.text ? a.values : b;
                        if (query.match(/^\s*(select|insert|update|delete|with)\s/i) && !query.includes(';')) {
                            // Explain it
                            const explain = `explain ${query}`;
                            pgClient._explainResults.push({
                                query,
                                result: pgClient[$$pgClientOrigQuery]
                                    .call(this, explain, values)
                                    .then((data) => data.rows)
                                    // swallow errors during explain
                                    .catch(() => null),
                            });
                        }
                    }
                    const promiseResult = pgClient[$$pgClientOrigQuery].apply(this, args);
                    if (debugPgError.enabled) {
                        // Report the error with our Postgres debugger.
                        promiseResult.catch(logError);
                    }
                    return promiseResult;
                }
                else {
                    // We don't understand it (e.g. `pgPool.query`), just let it happen.
                    return pgClient[$$pgClientOrigQuery].apply(this, args);
                }
            };
        }
    }
    return pgClient;
}
exports.debugPgClient = debugPgClient;
/**
 * Safely gets the value at `path` (array of keys) of `inObject`.
 *
 * @private
 */
function getPath(inObject, path) {
    let object = inObject;
    // From https://github.com/lodash/lodash/blob/master/.internal/baseGet.js
    let index = 0;
    const length = path.length;
    while (object && index < length) {
        object = object[path[index++]];
    }
    return index && index === length ? object : undefined;
}
/**
 * Check if a pgSetting is a string or a number.
 * Null and Undefined settings are not valid and will be ignored.
 * pgSettings of other types throw an error.
 *
 * @private
 */
function isPgSettingValid(pgSetting) {
    if (pgSetting === undefined || pgSetting === null) {
        return false;
    }
    const typeOfPgSetting = typeof pgSetting;
    if (typeOfPgSetting === 'string' ||
        typeOfPgSetting === 'number' ||
        typeOfPgSetting === 'boolean') {
        return true;
    }
    // TODO: booleans!
    throw new Error(`Error converting pgSetting: ${typeof pgSetting} needs to be of type string, number or boolean.`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2l0aFBvc3RHcmFwaGlsZUNvbnRleHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvcG9zdGdyYXBoaWxlL3dpdGhQb3N0R3JhcGhpbGVDb250ZXh0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSx3Q0FBeUM7QUFDekMsb0NBQXFDO0FBRXJDLHFDQUF5RTtBQUN6RSwrQkFBK0I7QUFDL0IsbUZBQXVFO0FBQ3ZFLDZDQUFxRDtBQUVyRCx5REFBMEQ7QUFFMUQsTUFBTSxnQkFBZ0IsR0FBRyxDQUN2QixDQUE0QyxFQUNVLEVBQUUsQ0FDeEQsQ0FBQyxJQUFJLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFZdkQsTUFBTSxPQUFPLEdBQUcsY0FBYyxDQUFDLHVCQUF1QixDQUFDLENBQUM7QUFDeEQsTUFBTSxZQUFZLEdBQUcsY0FBYyxDQUFDLDZCQUE2QixDQUFDLENBQUM7QUFDbkUsTUFBTSxhQUFhLEdBQUcsY0FBYyxDQUFDLDhCQUE4QixDQUFDLENBQUM7QUFFckU7O0dBRUc7QUFDSCxTQUFTLGtCQUFrQixDQUFDLE9BQWlDLEVBQUUsTUFBZ0I7SUFDN0UsT0FBTyxDQUNMLGNBQWMsRUFDZCxNQUFNLENBQUMsUUFBUSxJQUFJLE9BQU8sRUFDMUIsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxNQUFNLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFDckMsTUFBTSxDQUFDLE9BQU8sSUFBSSxNQUFNLEVBQ3hCLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLGFBQWEsTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQy9DLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFlBQVksTUFB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