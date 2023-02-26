module.exports = {
	testMatch: [
		'**/*.test.js',
		'**/*.test.ts',
	],

	testPathIgnorePatterns: [
		'<rootDir>/node_modules/',
		'<rootDir>/rnInjectedJs/',
		'<rootDir>/vendor/',
	],

	testEnvironment: 'node',

	setupFilesAfterEnv: [`${__dirname}/jest.setup.js`],
	slowTestThreshold: 40,

	preset: 'ts-jest',
};
