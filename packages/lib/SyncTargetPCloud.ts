import { _ } from './locale';
import Setting from './models/Setting';
import Synchronizer from './Synchronizer';
import BaseSyncTarget from './BaseSyncTarget';
import PCloudApi from './PCloudApi';
import FileApiDriverPCloud from './FileApiDriverPCloud';

const { parameters } = require('./parameters.js');
const { FileApi } = require('./file-api.js');

export default class SyncTargetPCloud extends BaseSyncTarget {

	private api_: PCloudApi;

	static id() {
		return 11;
	}

	constructor(db: any, options: any = null) {
		super(db, options);
		this.api_ = null;
	}

	static targetName() {
		return 'pcloud';
	}

	static label() {
		return _('pCloud');
	}

	public static description() {
		return 'A secure file hosting service with data centers based in Europe.';
	}

	public static supportsSelfHosted(): boolean {
		return false;
	}

	async isAuthenticated() {
		return !!this.api().auth;
	}

	syncTargetId() {
		return SyncTargetPCloud.id();
	}

	pcloudParameters() {
		const p = parameters();
		return p.pcloud;
	}

	authRouteName() {
		return 'PCloudLogin';
	}

	api() {
		if (this.api_) return this.api_;

		const isPublic = Setting.value('appType') !== 'cli' && Setting.value('appType') !== 'desktop';

		this.api_ = new PCloudApi(this.pcloudParameters().id, this.pcloudParameters().secret, isPublic);

		this.api_.on('authRefreshed', (a: any) => {
			this.logger().info('Saving updated PCloud auth.');
			Setting.setValue(`sync.${this.syncTargetId()}.auth`, a ? JSON.stringify(a) : null);
		});

		let auth = Setting.value(`sync.${this.syncTargetId()}.auth`);
		if (auth) {
			try {
				auth = JSON.parse(auth);
			} catch (error) {
				this.logger().warn('Could not parse PCloud auth token', error);
				auth = null;
			}
			this.api_.setAuth(auth);
		}

		return this.api_;
	}

	async initFileApi() {
		// let context = Setting.value(`sync.${this.syncTargetId()}.context`);
		// context = context === '' ? null : JSON.parse(context);
		// TODO create proper context
		const fileApi = new FileApi('', new FileApiDriverPCloud(this.api()));
		fileApi.setSyncTargetId(this.syncTargetId());
		fileApi.setLogger(this.logger());
		return fileApi;
	}

	async initSynchronizer() {
		try {
			if (!(await this.isAuthenticated())) throw new Error('User is not authenticated');
			return new Synchronizer(this.db(), await this.fileApi(), Setting.value('appType'));
		} catch (error) {
			BaseSyncTarget.dispatch({ type: 'SYNC_REPORT_UPDATE', report: { errors: [error] } });
			throw error;
		}


	}
}
