/* Print button on /resume. External file (rather than an inline <script>) so
   the site CSP can serve script-src without 'unsafe-inline'. */
(function () {
	'use strict';
	var btn = document.getElementById('resume-print');
	if (btn) {
		btn.addEventListener('click', function () {
			window.print();
		});
	}
})();
