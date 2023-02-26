import PCloudApi, { PcloudFileDescriptorResponse, PcloudFileMetadata, PCloudResponseCodes } from './PCloudApi';
import Logger from './Logger';
import { basename } from './path-utils';
import * as https from 'https';

const moment = require('moment');
const { basicDelta } = require('./file-api');
const { dirname } = require('./path-utils');

const logger = Logger.create('FileApiDriverPCloud');
const PCLOUD_DATE_FORMAT = 'ddd, DD MMM YYYY HH:mm:ss Z';

export interface PcloudFileStat {
    path: string;
    isDir: boolean;
    isDeleted?: boolean;
    updated_time?: number;
    created_time?: number;

    folderid?: string;
}

export default class FileApiDriverPCloud {
	private api_: PCloudApi;

	constructor(api: PCloudApi) {
		this.api_ = api;
	}

	api() {
		return this.api_;
	}

	private makePath(path: string) {
		if (path.startsWith('/')) {
			return path;
		}
		return `/${path}`;
	}

	private makeItems(odItems: PcloudFileMetadata[]) {
		const output = [];
		for (let i = 0; i < odItems.length; i++) {
			output.push(this.makeItem(odItems[i]));
		}
		return output;
	}

	private makeItem(odItem: PcloudFileMetadata): PcloudFileStat {
		const output: PcloudFileStat = {
			path: odItem.name,
			isDir: odItem.isfolder,
		};

		if (odItem.isdeleted) {
			output.isDeleted = true;
		} else {
			output.created_time = moment(odItem.created, PCLOUD_DATE_FORMAT).format('x');
			output.updated_time = Number(moment(odItem.modified, PCLOUD_DATE_FORMAT).format('x'));
		}

		return output;
	}

	private async statRaw(path: string): Promise<PcloudFileMetadata> {
		if ('' === path) {
			return this.rootFolderMetadata();
		}
		const response = await this.api_.exec('GET', 'stat', { path: this.makePath(path) });// TODO replace with fileId
		const jsonResponse = await response.json();
		if (jsonResponse.result !== PCloudResponseCodes.Ok) {
			if (jsonResponse.result === PCloudResponseCodes.FileNotFound) {
				return null;
			}
			throw Error(jsonResponse.error);
		}
		return jsonResponse.metadata;
	}

	private async rootFolderMetadata(): Promise<PcloudFileMetadata> {
		const response = await this.api_.execJson('GET', 'listfolder', { path: '/', recursive: 0 });
		return response.metadata;
	}

	async stat(path: string): Promise<PcloudFileStat> {
		const item = await this.statRaw(path);
		if (!item) return null;
		return this.makeItem(item);
	}

	async list(path: string, options: any = null) {
		const response = await this.api_.exec('GET', 'listfolder', { path: this.makePath(path), recursive: 1 }, options);
		const result = await response.json();
		let items = null;
		if (result.result === PCloudResponseCodes.FileNotFound) {
			items = [] as PcloudFileStat[];
		} else {
			items = this.makeItems(result.metadata.contents);
		}
		return {
			hasMore: false,
			items: items,
		};
	}

	async get(path: string, options: any = {}): Promise<string> {
		if (!options) options = {};
		try {
			if (options.target === 'file') {
				logger.debug(`executing content ${path}`);
				return await this.api_.execContent('GET', this.makePath(path), options); // TODO get content
			} else {
				logger.debug(`executing text ${path}`);
				return await this.api_.readRemoteFileContent('GET', this.makePath(path), options);
			}
		} catch (error) {
			if (error.code === 'itemNotFound') return null;
			throw error;
		}
	}

	async mkdir(path: string): Promise<PcloudFileStat> {
		const item = await this.stat(path);
		if (item) return item;

		const parentPath = dirname(path);
		const parentPathMetadata = await this.statRaw(parentPath);
		const newItem = await this.execCreateDir(parentPath, parentPathMetadata.folderid); // TODO recursive creation
		return this.makeItem(newItem);
	}

	async put(path: string, content: string, options: any = {}): Promise<Response> {
		path = this.makePath(path);
		if (!options) options = {};
		if (options.source === 'file') {
			return this.putFile(path, options);
		}
		if (!options.agent) {
			options.agent = new https.Agent({
				keepAlive: true,
				keepAliveMsecs: 1000,
			});
		}
		const query = { flags: 0x0040, path };
		const response = await this.api_.exec('GET', 'file_open', query, null, options);
		if (!response.ok) {
			throw Error(`Error creating file descriptor ${path} ${response.error}`);
		}
		const fileDescriptorResponse = await response.json() as PcloudFileDescriptorResponse;
		if (fileDescriptorResponse.result !== PCloudResponseCodes.Ok) {
			if (fileDescriptorResponse.result === PCloudResponseCodes.FileNotFound) { // parent directory does not exist
				await this.createDirRecursively(dirname(path));
				return await this.put(path, content, options);
			} else {
				throw Error(`Error creating file descriptor ${path}.PCloud error code: ${fileDescriptorResponse.result}. Cause ${fileDescriptorResponse.error}`);
			}
		}
		return this.api_.exec('PUT', 'file_write', { fd: fileDescriptorResponse.fd }, content, options);
	}

	private async createDirRecursively(directoryPath: string): Promise<PcloudFileMetadata> {
		if ('' === directoryPath || '/' === directoryPath) {
			return this.statRaw(directoryPath);
		}
		const parentDir = dirname(directoryPath);
		const baseDirStat = await this.fileExists(parentDir) ?
			await this.statRaw(parentDir) : await this.createDirRecursively(parentDir);
		return this.execCreateDir(basename(directoryPath), baseDirStat.folderid);
	}

	async fileExists(path: string): Promise<boolean> {
		const query = { path: this.makePath(path), recursive: 0 };
		const response = await this.api_.exec('GET', 'listfolder', query);
		const result = await response.json();
		if (result.result !== PCloudResponseCodes.Ok && result.result !== PCloudResponseCodes.ParentNotFound) {
			throw Error(`Cannot check directory for existence: ${result.error}`);
		}
		return result.result === PCloudResponseCodes.Ok;
	}

	async execCreateDir(name: string, parentFolderId: number): Promise<PcloudFileMetadata> {
		const response = await this.api_.exec('GET', 'createfolderifnotexists', { folderid: parentFolderId, name });
		const jsonResponse = await response.json();
		if (jsonResponse.result !== PCloudResponseCodes.Ok) {
			throw new Error(`Could not create directory: ${name}, parent: ${parentFolderId}. Cause: ${jsonResponse.result} - ${jsonResponse.error}`);
		}
		return jsonResponse.metadata;
	}

	private async putFile(path: string, options: any): Promise<Response> {
		const parentPath = dirname(path);
		logger.info(`Putting file ${options.path} to ${parentPath}`);
		options.source = 'file';
		if (!(await this.fileExists(parentPath))) {
			await this.createDirRecursively(parentPath);
		}
		return this.api_.exec('PUT', 'uploadfile', { path: `/${parentPath}`, filename: basename(path) }, null, options);
	}

	async delete(path: string) {
		path = this.makePath(path);
		const response = await this.api_.exec('GET', 'deletefile', { path });
		const jsonResponse = await response.json();
		if (jsonResponse.result !== PCloudResponseCodes.Ok) {
			throw new Error(`Could not delete file: ${path}. Cause: ${jsonResponse.error}`);
		}
		return jsonResponse.metadata;
	}

	async move() {
		// not supported yet
		throw new Error('Not implemented');
	}

	format() {
		throw new Error('Not implemented');
	}

	async clearRoot() { // TODO not yet implemented
		// const recurseItems = async (path: string) => {
		//     const result = await this.list(this.fileApi_.fullPath(path));
		//     const output = [];
		//
		//     for (const item of result.items) {
		//         const fullPath = `${path}/${item.path}`;
		//         if (item.isDir) {
		//             await recurseItems(fullPath);
		//         }
		//         await this.delete(this.fileApi_.fullPath(fullPath));
		//     }
		//
		//     return output;
		// };
		//
		// await recurseItems('');
	}

	async delta(path: string, options: any = {}) { // TODO not yet implemented
		const getDirStats = async (path: string) => {
			const result = await this.list(path, { includeDirs: false }); // TODO not implemented include dirs.
			return result.items;
		};
		return await basicDelta(path, getDirStats, options);
	}
}
