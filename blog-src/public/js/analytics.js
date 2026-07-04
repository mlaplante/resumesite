/*
 * Self-hosted Umami analytics, loaded lazily.
 *
 * The tracker is injected on the visitor's first interaction (pointer, key,
 * touch, or scroll) instead of during initial page load. This keeps the
 * third-party request off the critical path and means automated audits and
 * bots — which never interact — don't fire (and can't fail) the beacon.
 */
(function () {
	var UMAMI_SRC = 'https://laplantedevanalytics.netlify.app/script.js';
	var WEBSITE_ID = 'b7f548e1-c6ab-4900-8693-e500f5400f0f';
	var events = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
	var loaded = false;

	function load() {
		if (loaded) return;
		loaded = true;
		events.forEach(function (evt) {
			window.removeEventListener(evt, load);
		});

		var s = document.createElement('script');
		s.defer = true;
		s.src = UMAMI_SRC;
		s.setAttribute('data-website-id', WEBSITE_ID);
		document.head.appendChild(s);
	}

	events.forEach(function (evt) {
		window.addEventListener(evt, load, { once: true, passive: true });
	});
})();
