/* Blog nav hamburger toggle. Kept as an external file (rather than an inline
   <script>) so the site CSP can serve script-src without 'unsafe-inline'. */
(function () {
	'use strict';

	function init() {
		var nav = document.querySelector('.blog-nav');
		if (!nav) return;

		var themeToggle = nav.querySelector('.theme-toggle');
		if (themeToggle && window.__toggleTheme) {
			themeToggle.addEventListener('click', function () {
				window.__toggleTheme();
			});
		}

		var toggle = nav.querySelector('.nav-toggle');
		if (!toggle) return;
		toggle.addEventListener('click', function () {
			var open = nav.classList.toggle('nav-open');
			toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
		});
		// Close the menu when a link is tapped.
		nav.querySelectorAll('.nav-links a').forEach(function (link) {
			link.addEventListener('click', function () {
				nav.classList.remove('nav-open');
				toggle.setAttribute('aria-expanded', 'false');
			});
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
