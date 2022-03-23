"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.debugPgClient = void 0;
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
                return await callback({
                    [pgClientFromContext_1.$$pgClient]: pgClient,
                    pgRole,
                    jwtClaims,
                    ...(explain
                        ? {
                            getExplainResults: () => {
                                results = results || pgClient.stopExplain();
                                return results;
                            },
                        }
                        : null),
                });
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
                jwt.verify(jwtToken, jwtVerificationSecret, {
                    ...jwtVerifyOptions,
                    audience: jwtAudiences ||
                        (jwtVerifyOptions && 'audience' in jwtVerifyOptions
                            ? undefinedIfEmpty(jwtVerifyOptions.audience)
                            : ['postgraphile']),
                }, (err, decoded) => {
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
                const { result: resultPromise, ...rest } = r;
                const result = await resultPromise;
                const firstKey = result && result[0] && Object.keys(result[0])[0];
                if (!firstKey) {
                    return null;
                }
                const plan = result.map((r) => r[firstKey]).join('\n');
                return {
                    ...rest,
                    plan,
                };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2l0aFBvc3RHcmFwaGlsZUNvbnRleHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvcG9zdGdyYXBoaWxlL3dpdGhQb3N0R3JhcGhpbGVDb250ZXh0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLHdDQUF5QztBQUN6QyxvQ0FBcUM7QUFFckMscUNBQXlFO0FBQ3pFLCtCQUErQjtBQUMvQixtRkFBdUU7QUFDdkUsNkNBQXFEO0FBRXJELHlEQUEwRDtBQUUxRCxNQUFNLGdCQUFnQixHQUFHLENBQ3ZCLENBQTRDLEVBQ1UsRUFBRSxDQUN4RCxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQVl2RCxNQUFNLE9BQU8sR0FBRyxjQUFjLENBQUMsdUJBQXVCLENBQUMsQ0FBQztBQUN4RCxNQUFNLFlBQVksR0FBRyxjQUFjLENBQUMsNkJBQTZCLENBQUMsQ0FBQztBQUNuRSxNQUFNLGFBQWEsR0FBRyxjQUFjLENBQUMsOEJBQThCLENBQUMsQ0FBQztBQUVyRTs7R0FFRztBQUNILFNBQVMsa0JBQWtCLENBQUMsT0FBaUMsRUFBRSxNQUFnQjtJQUM3RSxPQUFPLENBQ0wsY0FBYyxFQUNkLE1BQU0sQ0FBQyxRQUFRLElBQUksT0FBTyxFQUMxQixNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUNyQyxNQUFNLENBQUMsT0FBTyxJQUFJLE1BQU0sRUFDeEIsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsYUFBYSxNQUFNLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFDL0MsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsWUFBWSxNQUFN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