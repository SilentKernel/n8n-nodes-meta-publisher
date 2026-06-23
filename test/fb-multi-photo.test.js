'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Target the compiled output so we exercise the code that actually ships.
const { OPS } = require('../dist/nodes/MetaPublisher/lib/ops.js');

// Make sleep()/jitter() instant so the create→attach→publish flow doesn't wait.
const realSetTimeout = global.setTimeout;
function instantTimers() {
	global.setTimeout = (fn) => {
		fn();
		return 0;
	};
	return () => {
		global.setTimeout = realSetTimeout;
	};
}

// Build a fake IExecuteFunctions that records every Graph API request and
// returns canned responses keyed by method + url.
function makeCtx() {
	const calls = [];
	const ctx = {
		getCredentials: async () => ({ accessToken: 'USER_TOKEN' }),
		getNode: () => ({ name: 'Meta Publisher' }),
		getNodeParameter: (name, _i, fallback) =>
			name === 'operation' ? 'publishFbMultiPhoto' : fallback,
		helpers: {
			request: async (options) => {
				calls.push(options);
				const { method, url, qs } = options;

				// Page access-token lookup: GET /{pageId}?fields=access_token
				if (method === 'GET' && qs && qs.fields === 'access_token') {
					return { access_token: 'PAGE_TOKEN' };
				}
				// Photo upload: POST /{pageId}/photos
				if (method === 'POST' && /\/photos$/.test(url)) {
					calls.photoCount = (calls.photoCount || 0) + 1;
					return { id: `photo_${calls.photoCount}` };
				}
				// Multi-photo feed post: POST /{pageId}/feed
				if (method === 'POST' && /\/feed$/.test(url)) {
					return { id: 'POST_123' };
				}
				// Permalink lookup: GET /{postId}?fields=permalink_url|... → returns url
				if (method === 'GET' && /POST_123$/.test(url)) {
					return { url: 'https://facebook.com/POST_123' };
				}
				throw new Error(`Unexpected request: ${method} ${url}`);
			},
		},
	};
	return { ctx, calls };
}

test('publishFbMultiPhoto uploads each photo unpublished then attaches them to one feed post', async () => {
	const restore = instantTimers();
	// Silence the verbose apiRequest debug logging during the test.
	const realLog = console.log;
	console.log = () => {};

	try {
		const { ctx, calls } = makeCtx();
		const items = [
			{ imageUrl: 'https://example.com/a.jpg', caption: 'A' },
			{ imageUrl: 'https://example.com/b.jpg' },
			{ imageUrl: 'https://example.com/c.jpg', caption: 'C' },
		];

		const result = await OPS.publishFbMultiPhoto(ctx, 0, {
			pageId: 'PAGE_1',
			items,
			caption: 'My album',
		});

		// 1) Page access token fetched exactly once.
		const tokenCalls = calls.filter((c) => c.method === 'GET' && c.qs?.fields === 'access_token');
		assert.strictEqual(tokenCalls.length, 1, 'page access token fetched once');

		// 2) Exactly 3 unpublished photo uploads, each with published:false and its url.
		const photoCalls = calls.filter((c) => c.method === 'POST' && /\/photos$/.test(c.url));
		assert.strictEqual(photoCalls.length, 3, 'three photos uploaded');
		for (const c of photoCalls) {
			assert.strictEqual(c.body.published, false, 'photo uploaded unpublished');
			assert.ok(c.body.url, 'photo upload carries a url');
		}
		assert.strictEqual(photoCalls[0].body.caption, 'A', 'per-photo caption forwarded');

		// 3) One feed post attaching all 3 photos in order, with the post message.
		const feedCalls = calls.filter((c) => c.method === 'POST' && /\/feed$/.test(c.url));
		assert.strictEqual(feedCalls.length, 1, 'single feed post created');
		const feed = feedCalls[0];
		assert.strictEqual(feed.body.message, 'My album', 'post message set');
		assert.deepStrictEqual(
			feed.body.attached_media,
			[{ media_fbid: 'photo_1' }, { media_fbid: 'photo_2' }, { media_fbid: 'photo_3' }],
			'attached_media references all uploaded photo ids in order',
		);

		// 4) Returned PublishResult shape.
		assert.strictEqual(result.type, 'multi_photo');
		assert.strictEqual(result.platform, 'facebook');
		assert.strictEqual(result.published, true);
		assert.deepStrictEqual(result.children, ['photo_1', 'photo_2', 'photo_3']);
		assert.strictEqual(result.permalink, 'https://facebook.com/POST_123');
	} finally {
		console.log = realLog;
		restore();
	}
});
