/* Cal.com inline embed bootstrap for the booking section on /services.
   External file (rather than an inline <script>) so the site CSP can serve
   script-src without 'unsafe-inline'; app.cal.com is the only third-party
   origin involved and is allowlisted in public/_headers. */
(function () {
	'use strict';

	var mount = document.getElementById('cal-booking');
	if (!mount) return;
	var calLink = mount.getAttribute('data-cal-link');
	if (!calLink) return;

	/* Official Cal.com embed loader snippet (queues calls until embed.js loads). */
	(function (C, A, L) {
		var p = function (a, ar) { a.q.push(ar); };
		var d = C.document;
		C.Cal = C.Cal || function () {
			var cal = C.Cal;
			var ar = arguments;
			if (!cal.loaded) {
				cal.ns = {};
				cal.q = cal.q || [];
				d.head.appendChild(d.createElement('script')).src = A;
				cal.loaded = true;
			}
			if (ar[0] === L) {
				var api = function () { p(api, arguments); };
				var namespace = ar[1];
				api.q = api.q || [];
				if (typeof namespace === 'string') {
					cal.ns[namespace] = cal.ns[namespace] || api;
					p(cal.ns[namespace], ar);
					p(cal, ['initNamespace', namespace]);
				} else {
					p(cal, ar);
				}
				return;
			}
			p(cal, ar);
		};
	})(window, 'https://app.cal.com/embed/embed.js', 'init');

	/* Match the site's effective theme. theme.js stamps data-theme on <html>
	   before this runs; fall back to the same explicit-choice-then-OS logic
	   if it didn't load. */
	var dark = document.documentElement.getAttribute('data-theme') === 'dark';
	if (!document.documentElement.hasAttribute('data-theme')) {
		try {
			var stored = localStorage.getItem('darkMode');
			dark = stored === 'enabled' ||
				(stored !== 'disabled' && window.matchMedia('(prefers-color-scheme: dark)').matches);
		} catch (e) {
			/* localStorage unavailable — keep the light theme */
		}
	}

	window.Cal('init', { origin: 'https://app.cal.com' });
	window.Cal('inline', {
		elementOrSelector: '#cal-booking',
		calLink: calLink,
		config: { theme: dark ? 'dark' : 'light' },
	});
	window.Cal('ui', {
		hideEventTypeDetails: false,
		cssVarsPerTheme: {
			light: { 'cal-brand': '#1a5276' },
			dark: { 'cal-brand': '#60a5fa' },
		},
	});
})();
