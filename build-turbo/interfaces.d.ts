/// <reference types="node" />
import { GraphQLError, GraphQLSchema, SourceLocation, DocumentNode } from 'graphql';
import { IncomingMessage, ServerResponse } from 'http';
import { PluginHookFn } from './postgraphile/pluginHook';
import { Pool } from 'pg';
import { Plugin, PostGraphileCoreOptions } from 'postgraphile-core';
import jwt = require('jsonwebtoken');
import { EventEmitter } from 'events';
import { PostGraphileResponse } from './postgraphile/http/frameworks';
import { ShutdownActions } from './postgraphile/shutdownActions';
declare type PromiseOrDirect<T> = T | Promise<T>;
declare type DirectOrCallback<Request, T> = T | ((req: Request) => PromiseOrDirect<T>);
/**
 * A narrower type than `any` that won’t swallow errors from assumptions about
 * code.
 *
 * For example `(x as any).anything()` is ok. That function then returns `any`
 * as well so the problem compounds into `(x as any).anything().else()` and the
 * problem just goes from there. `any` is a type black hole that swallows any
 * useful type information and shouldn’t be used unless you know what you’re
 * doing.
 *
 * With `mixed` you must *prove* the type is what you want to use.
 *
 * The `mixed` type is identical to the `mixed` type in Flow.
 *
 * @see https://github.com/Microsoft/TypeScript/issues/9999
 * @see https://flowtype.org/docs/builtins.html#mixed
 */
export declare type mixed = Record<string, any> | string | number | boolean | undefined | null;
export declare type Middleware<Request extends IncomingMessage = IncomingMessage, Response extends ServerResponse = ServerResponse> = (req: Request, res: Response, next: (errOrEscape?: any) => void) => void;
export interface PostGraphileOptions<Request extends IncomingMessage = IncomingMessage, Response extends ServerResponse = ServerResponse> extends PostGraphileCoreOptions {
    watchPg?: boolean;
    retryOnInitFail?: boolean | ((error: Error, attempts: number) => boolean | Promise<boolean>);
    ownerConnectionString?: string;
    subscriptions?: boolean;
    live?: boolean;
    websockets?: ('v0' | 'v1')[];
    websocketOperations?: 'all' | 'subscriptions';
    websocketMiddlewares?: Array<Middleware<Request, Response>>;
    pgDefaultRole?: string;
    dynamicJson?: boolean;
    setofFunctionsContainNulls?: boolean;
    classicIds?: boolean;
    disableDefaultMutations?: boolean;
    ignoreRBAC?: boolean;
    ignoreIndexes?: boolean;
    includeExtensionResources?: boolean;
    showErrorStack?: boolean | 'json';
    extendedErrors?: Array<string>;
    handleErrors?: (errors: ReadonlyArray<GraphQLError>, req: Request, res: Response) => ReadonlyArray<GraphQLError | GraphQLErrorExtended>;
    appendPlugins?: Array<Plugin>;
    prependPlugins?: Array<Plugin>;
    replaceAllPlugins?: Array<Plugin>;
    skipPlugins?: Array<Plugin>;
    readCache?: string | Record<string, any>;
    writeCache?: string;
    exportJsonSchemaPath?: string;
    exportGqlSchemaPath?: string;
    sortExport?: boolean;
    graphqlRoute?: string;
    eventStreamRoute?: string;
    externalGraphqlRoute?: string;
    externalEventStreamRoute?: string;
    graphiqlRoute?: string;
    externalUrlBase?: string;
    graphiql?: boolean;
    graphiqlCredentials?: 'include' | 'omit' | 'same-origin';
    enhanceGraphiql?: boolean;
    enableCors?: boolean;
    bodySizeLimit?: string;
    enableQueryBatching?: boolean;
    jwtSecret?: jwt.Secret;
    jwtPublicKey?: jwt.Secret | jwt.GetPublicKeyOrSecret;
    jwtVerifyOptions?: jwt.VerifyOptions;
    jwtSignOptions?: jwt.SignOptions;
    jwtRole?: Array<string>;
    jwtPgTypeIdentifier?: string;
    jwtAudiences?: Array<string>;
    legacyRelations?: 'only' | 'deprecated' | 'omit';
    legacyJsonUuid?: boolean;
    disableQueryLog?: boolean;
    pgSettings?: DirectOrCallback<Request, {
        [key: string]: mixed;
    }>;
    allowExplain?: DirectOrCallback<Request, boolean>;
    additionalGraphQLContextFromRequest?: (req: Request, res: Response) => Promise<Record<string, any>>;
    pluginHook?: PluginHookFn;
    simpleCollections?: 'omit' | 'both' | 'only';
    queryCacheMaxSize?: number;
}
export interface CreateRequestHandlerOptions extends PostGraphileOptions {
    getGqlSchema: () => Promise<GraphQLSchema>;
    pgPool: Pool;
    _emitter: EventEmitter;
    shutdownActions: ShutdownActions;
}
export interface GraphQLFormattedErrorExtended {
    message: string;
    locations: ReadonlyArray<SourceLocation> | void;
    path: ReadonlyArray<string | number> | void;
    extensions?: {
        [s: string]: any;
    };
}
export declare type GraphQLErrorExtended = GraphQLError & {
    extensions: {
        exception: {
            hint?: string;
            detail?: string;
            code: string;
        };
    };
};
/**
 * A request handler for one of many different `http` frameworks.
 */
export interface HttpRequestHandler<Request extends IncomingMessage = IncomingMessage, Response extends ServerResponse = ServerResponse> {
    (req: Request, res: Response, next?: (error?: mixed) => void): Promise<void>;
    (ctx: {
        req: Request;
        res: Response;
    }, next: () => void): Promise<void>;
    formatError: (e: GraphQLError) => GraphQLFormattedErrorExtended;
    getGraphQLSchema: () => Promise<GraphQLSchema>;
    pgPool: Pool;
    withPostGraphileContextFromReqRes: (req: Request, res: Response, moreOptions: any, fn: (ctx: mixed) => any) => Promise<any>;
    options: CreateRequestHandlerOptions;
    handleErrors: (errors: ReadonlyArray<GraphQLError>, req: Request, res: Response) => ReadonlyArray<GraphQLError | GraphQLErrorExtended>;
    graphqlRoute: string;
    graphqlRouteHandler: (res: PostGraphileResponse) => Promise<void>;
    graphiqlRoute: string;
    graphiqlRouteHandler: ((res: PostGraphileResponse) => Promise<void>) | null;
    faviconRouteHandler: ((res: PostGraphileResponse) => Promise<void>) | null;
    eventStreamRoute: string;
    eventStreamRouteHandler: ((res: PostGraphileResponse) => Promise<void>) | null;
    /** Experimental! */
    release: () => Promise<void>;
}
export declare type TransactionIsolationLevel = 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
/**
 * Options passed to the `withPostGraphileContext` function
 */
export interface WithPostGraphileContextOptions {
    pgPool: Pool;
    jwtToken?: string;
    jwtSecret?: jwt.Secret;
    jwtPublicKey?: jwt.Secret | jwt.GetPublicKeyOrSecret;
    jwtAudiences?: Array<string>;
    jwtRole?: Array<string>;
    jwtVerifyOptions?: jwt.VerifyOptions;
    pgDefaultRole?: string;
    pgSettings?: {
        [key: string]: mixed;
    };
    explain?: boolean;
    queryDocumentAst?: DocumentNode;
    operationName?: string;
    pgForceTransaction?: boolean;
    singleStatement?: boolean;
    transactionIsolationLevel?: TransactionIsolationLevel;
    variables?: any;
}
export {};
