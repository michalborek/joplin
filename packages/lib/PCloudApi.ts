import shim from './shim';
import time from './time';
import Logger from './Logger';

const { stringify } = require('query-string');
const Buffer = require('buffer').Buffer;

const logger = Logger.create('PCloudApi');

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type PCloudApiCommand =
    'createfolderifnotexists' |
    'uploadfile' |
    'listfolder' |
    'stat' |
    'deletefile' |
    'file_read' |
    'file_open' |
    'file_close' |
    'file_size' |
    'file_write';

interface PcloudAuth {
    access_token: string;
    token_type: string;
    userid: number;
    locationid: 1 | 2;
    hostname: 'api.pcloud.com' | 'eapi.pcloud.com';
}

export interface PcloudFileMetadata {
    created?: string;
    fileid?: number;
    hash?: number;
    icon?: string;
    id?: string;
    isfolder?: boolean;
    ismine?: boolean;
    isshared?: boolean;
    isdeleted?: boolean;
    modified?: string;
    name?: string;
    parentfolderid?: number;
    size?: number;

    folderid?: number;
}

export interface PcloudFileDescriptorResponse {
    result: number;
    fd: number;

    error?: string;
}

export enum PCloudResponseCodes {
    Ok = 0,
    FileNotFound = 2002,
    ParentNotFound = 2005,
}

export default class PCloudApi {

	private clientId_: string;
	private clientSecret_: string;
	private auth_: PcloudAuth = null;
	private isPublic_: boolean;
	private listeners_: Record<string, any>;

	// `isPublic` is to tell OneDrive whether the application is a "public" one (Mobile and desktop
	// apps are considered "public"), in which case the secret should not be sent to the API.
	// In practice the React Native app is public, and the Node one is not because we
	// use a local server for the OAuth dance.
	constructor(clientId: string, clientSecret: string, isPublic: boolean) {
		this.clientId_ = clientId;
		this.clientSecret_ = clientSecret;
		this.auth_ = null;
		this.isPublic_ = isPublic;
		this.listeners_ = {
			authRefreshed: [],
		};
	}

	isPublic() {
		return this.isPublic_;
	}

	dispatch(eventName: string, param: any) {
		const ls = this.listeners_[eventName];
		for (let i = 0; i < ls.length; i++) {
			ls[i](param);
		}
	}

	on(eventName: string, callback: Function) {
		this.listeners_[eventName].push(callback);
	}

	tokenBaseUrl(apiHostname: string) {
		return `https://${apiHostname}/oauth2_token`;
	}

	apiUrl(command: PCloudApiCommand, queryString: string = ''): string {
		return `https://${this.auth_.hostname}/${command}?${queryString}`;
	}

	nativeClientRedirectUrl() {
		return 'https://my.pcloud.com/oauth2/authorize';
	}

	get auth(): PcloudAuth {
		return this.auth_;
	}

	setAuth(auth: PcloudAuth) {
		this.auth_ = auth;
		this.dispatch('authRefreshed', this.auth);
	}

	get token() {
		return this.auth_ ? this.auth_.access_token : null;
	}

	clientId() {
		return this.clientId_;
	}

	clientSecret() {
		return this.clientSecret_;
	}

	authCodeUrl(redirectUri: string) {
		const query = {
			client_id: this.clientId_,
			scope: 'files.readwrite offline_access sites.readwrite.all',
			response_type: 'code',
			redirect_uri: redirectUri,
			prompt: 'login',
		};
		return `https://my.pcloud.com/oauth2/authorize?${stringify(query)}`; // locationEurope removed
	}

	async execTokenRequest(code: string, apiHostname: string) {
		const response = await shim.fetch(`${this.tokenBaseUrl(apiHostname)}?client_secret=${this.clientSecret()}&code=${code}&client_id=${this.clientId()}`, {
			method: 'GET',
		});
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Could not retrieve auth code: ${response.status}: ${response.statusText}: ${text}`);
		}
		try {
			const authenticationResponse = await response.json();
			authenticationResponse.hostname = apiHostname;
			this.setAuth(authenticationResponse);
		} catch (error) {
			this.setAuth(null);
			const text = await response.text();
			error.message += `: ${text}`;
			throw error;
		}
	}

	responseToError(errorResponse: any) {
		if (!errorResponse) return new Error('Undefined error');

		if (errorResponse.error) {
			const e = errorResponse.error;
			const output: any = new Error(e.message);
			if (e.code) output.code = e.code;
			if (e.innerError) output.innerError = e.innerError;
			return output;
		} else {
			return new Error(JSON.stringify(errorResponse));
		}
	}

	async uploadChunk(url: string, handle: any, buffer: any, options: any) {
		options = Object.assign({}, options);
		if (!options.method) {
			options.method = 'POST';
		}

		if (!options.contentLength) throw new Error('uploadChunk: contentLength is missing');
		if (!options.headers) throw new Error('uploadChunk: header is missing');

		if (buffer) {
			options.body = buffer.slice(options.startByte, options.startByte + options.contentLength);
		} else {
			const chunk = await shim.fsDriver().readFileChunk(handle, options.contentLength);
			options.body = Buffer.from(chunk, 'base64');
		}

		delete options.contentLength;
		delete options.startByte;

		return await shim.fetch(url, options);
	}

	async exec(method: HttpMethod, command: PCloudApiCommand, query: {} = null, data: any = null, options: any = null) {
		if (!options) options = {};
		if (!options.headers) options.headers = {};
		if (!options.target) options.target = 'string';

		if (method !== 'GET') {
			options.method = method;
		}

		const url = this.apiUrl(command, `?${query}` ? stringify(query) : '');

		if (data) {
			options.body = data;
		}

		options.timeout = 1000 * 60 * 5; // in ms

		for (let i = 0; i < 5; i++) {
			options.headers['Authorization'] = `bearer ${this.token}`;
			options.headers['User-Agent'] = `ISV|Joplin|Joplin/${shim.appVersion()}`;
			const handleRequestRepeat = async (_: any, sleepSeconds: number = null) => {
				sleepSeconds ??= (i + 1) * 5;
				logger.info(`Got error below - retrying (${i})...`);
				await time.sleep(sleepSeconds);
			};

			let response = null;
			logger.debug(`Exec::request: ${url}`);
			try {
				if (options.source === 'file' && (method === 'POST' || method === 'PUT')) {
					response = await shim.uploadBlob(url, options);
				} else if (options.target === 'string') {
					response = await shim.fetch(url, options);
				} else {
					// file
					response = await shim.fetchBlob(url, options);
				}
			} catch (error) {
				logger.error(error.message);
				if (shim.fetchRequestCanBeRetried(error)) {
					await handleRequestRepeat(error);
					continue;
				} else {
					logger.error('Got unhandled error:', error ? error.code : '', error ? error.message : '', error);
					throw error;
				}
			}
			if (!response.ok) {
				const errorResponseText = await response.text();
				let errorResponse = null;

				try {
					errorResponse = JSON.parse(errorResponseText); // await response.json();
				} catch (error) {
					error.message = `PCloudAPi::exec: Cannot parse JSON error: ${errorResponseText} ${error.message}`;
					await handleRequestRepeat(error);
					continue;
				}

				const error = this.responseToError(errorResponse);
				if (error.code === 'InvalidAuthenticationToken' || error.code === 'unauthenticated') {
					logger.info('Token expired: refreshing...');
					// await this.refreshAccessToken(); // FIXME refreshing token does not work in pCloud - authenticate again?
					continue;
				} else if (error && ((error.error && error.error.code === 'generalException') || error.code === 'generalException' || error.code === 'EAGAIN')) {
					await handleRequestRepeat(error);
					continue;
				} else if (error && (error.code === 'resourceModified' || (error.error && error.error.code === 'resourceModified'))) {
					await handleRequestRepeat(error);
					continue;
				} else if (error?.code === 'activityLimitReached' && response?.headers?._headers['retry-after'][0] && !isNaN(Number(response?.headers?._headers['retry-after'][0]))) {
					i--;
					const sleepSeconds = response.headers._headers['retry-after'][0];
					logger.info(`OneDrive Throttle, sync thread sleeping for ${sleepSeconds} seconds...`);
					await handleRequestRepeat(error, Number(sleepSeconds));
					continue;
				} else if (error.code === 'itemNotFound' && method === 'DELETE') {
					// Deleting a non-existing item is ok - noop
					return;
				} else {
					error.request = `${method} ${url} ${JSON.stringify(query)} ${JSON.stringify(data)} ${JSON.stringify(options)}`;
					error.headers = await response.headers;
					throw error;
				}
			}

			return response;
		}

		throw new Error(`Could not execute request after multiple attempts: ${method} ${url}`);
	}

	async execJson(method: HttpMethod, command: PCloudApiCommand, query: any = null, data: any = null) {
		const response = await this.exec(method, command, query, data);
		const responseText = await response.text();
		try {
			return JSON.parse(responseText);
		} catch (error) {
			error.message = `PCloudAPI::execJson: Cannot parse JSON: ${responseText} ${error.message}`;
			throw error;
		}
	}

	async readRemoteFileContent(method: HttpMethod, path: string, options: any = {}): Promise<string> {
		options.agent = shim.httpAgent('https://');
		const response = await this.exec(method, 'file_open', { flags: 0, path: `/${path}` }, null, options);
		if (!response.ok) {
			logger.error(`Error reading file content ${path}`, response.error);
			throw Error(response.errorMessage);
		}
		const fileDescriptorResponse = await response.json() as PcloudFileDescriptorResponse;
		const fileSize = await this.fileSizeInBytes(fileDescriptorResponse.fd, options);
		const readResponse = await this.exec('GET', 'file_read', {
			fd: fileDescriptorResponse.fd,
			count: fileSize,
		}, null, options);
		if (readResponse.ok) {
			return await readResponse.text();
		} else {
			logger.error('Error reading file content file_read', readResponse.errorMessage);
			return null;
		}
	}

	async execContent(method: HttpMethod, path: string, options: any = {}) {
		options.agent = shim.httpAgent('https://');
		const response = await this.exec(method, 'file_open', { flags: 0, path: `/${path}` }, null, options);
		if (!response.ok) {
			logger.error(`Error reading file content ${path}`, response.error);
			return;
		}
		const fileDescriptorResponse = await response.json() as PcloudFileDescriptorResponse;
		const fileSize = this.fileSizeInBytes(fileDescriptorResponse.fd, options);
		const readResponse = await this.exec('GET', 'file_read', {
			fd: fileDescriptorResponse.fd,
			count: fileSize,
		}, null, options);
		if (readResponse.ok) {
			return response;
		} else {
			throw Error(`Error reading file content file_read: ${readResponse.errorMessage}`);
		}
	}

	async fileSizeInBytes(fileDescriptor: number, options: any): Promise<number> {
		const response = await this.exec('GET', 'file_size', { fd: fileDescriptor }, null, options);// TODO replace with fileId
		const jsonResponse = await response.json();
		if (jsonResponse.result !== PCloudResponseCodes.Ok) {
			logger.error(`Error getting file stat ${jsonResponse.error}`);
			return undefined;
		}
		return jsonResponse.size;
	}
}
