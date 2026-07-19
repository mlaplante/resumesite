/* Site-wide theme bootstrap. Loaded as a blocking script at the top of
   <head> (external file so the CSP can serve script-src without
   'unsafe-inline') so the correct theme is stamped on <html> before first
   paint — no light-mode flash for dark-theme users.

   Source of truth: localStorage('darkMode') — 'enabled' | 'disabled',
   the convention the portfolio toggle has always used. No stored choice
   means "follow the OS preference". The effective theme is exposed two
   ways, kept in sync:
     - <html data-theme="dark|light">  → all stylesheet theming
     - <body class="dark-mode">        → legacy portfolio styles (style.css)
   Without JavaScript neither hook is set and the site renders light. */
(function () {
	'use strict';

	var root = document.documentElement;
	var media = window.matchMedia('(prefers-color-scheme: dark)');

	/* Scroll-animation guard. This blocking head script runs before first
	   paint, so adding `js-anim` here lets style.css apply the hidden starting
	   state (opacity:0) to [data-aos] elements with no flash. Content is
	   visible by default in CSS, so if this script never runs the page still
	   renders fully instead of blanking.

	   Failsafe: script.js normally reveals the content (and sets
	   window.__aosReady). If it fails to run for any reason, reveal everything
	   so the page is never left blank. Two triggers: shortly after `load`,
	   plus a hard deadline from now — on flaky mobile connections `load` can
	   be delayed indefinitely by a hanging subresource, which used to leave
	   [data-aos] content invisible with no recovery. */
	root.classList.add('js-anim');
	var forceReveal = function () {
		if (window.__aosReady) return; /* reveal script ran; it owns the animation */
		var nodes = document.querySelectorAll('[data-aos]');
		for (var i = 0; i < nodes.length; i++) {
			nodes[i].classList.add('aos-animate');
		}
	};
	/* script.js is deferred, so it has already run (and set __aosReady) by
	   the time DOMContentLoaded fires — unless its request failed. */
	document.addEventListener('DOMContentLoaded', function () {
		window.setTimeout(forceReveal, 300);
	});
	window.addEventListener('load', function () {
		window.setTimeout(forceReveal, 300);
	});
	window.setTimeout(forceReveal, 2500);

	function stored() {
		try {
			return localStorage.getItem('darkMode');
		} catch (e) {
			return null;
		}
	}

	function effectiveDark() {
		var choice = stored();
		return choice === 'enabled' || (choice !== 'disabled' && media.matches);
	}

	function apply() {
		var dark = effectiveDark();
		root.setAttribute('data-theme', dark ? 'dark' : 'light');
		if (document.body) {
			document.body.classList.toggle('dark-mode', dark);
		}
	}

	apply();
	/* <body> doesn't exist during the early head run — sync its class once
	   the DOM is ready. */
	document.addEventListener('DOMContentLoaded', apply);

	/* Track OS theme changes while the user hasn't made an explicit choice. */
	var onChange = function () {
		if (!stored()) apply();
	};
	if (media.addEventListener) {
		media.addEventListener('change', onChange);
	} else if (media.addListener) {
		media.addListener(onChange); /* older Safari */
	}

	/* Shared toggle used by the portfolio and blog nav buttons. */
	window.__toggleTheme = function () {
		try {
			localStorage.setItem('darkMode', effectiveDark() ? 'disabled' : 'enabled');
		} catch (e) {
			/* localStorage unavailable — still flip the theme for this page view */
			root.setAttribute(
				'data-theme',
				root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
			);
			if (document.body) {
				document.body.classList.toggle('dark-mode');
			}
			return;
		}
		apply();
	};
})();
