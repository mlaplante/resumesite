/*========================================
	Modern Vanilla JavaScript Implementation
	No jQuery dependencies
==========================================*/
(function() {
	'use strict';

	/*========================================
		Set Copyright Year
	==========================================*/
	var copyrightYearElement = document.getElementById('copyright-year');
	if (copyrightYearElement) {
		copyrightYearElement.textContent = new Date().getFullYear();
	}

	/*========================================
		Dark Mode Toggle
	==========================================*/
	var DARK_MODE_ENABLED = 'enabled';
	var DARK_MODE_DISABLED = 'disabled';
	
	function initDarkMode() {
		var body = document.body;
		var darkModeToggle = document.querySelector('.dark-mode-toggle');
		
		if (!darkModeToggle) return;
		
		// Check for saved dark mode preference
		var darkMode = localStorage.getItem('darkMode');
		
		if (darkMode === DARK_MODE_ENABLED) {
			body.classList.add('dark-mode');
		}
		
		// Toggle dark mode
		darkModeToggle.addEventListener('click', function(e) {
			e.preventDefault();
			body.classList.toggle('dark-mode');
			
			// Save preference
			if (body.classList.contains('dark-mode')) {
				localStorage.setItem('darkMode', DARK_MODE_ENABLED);
			} else {
				localStorage.setItem('darkMode', DARK_MODE_DISABLED);
			}
		});
	}

	/*========================================
		Native Scroll Animations
	==========================================*/
	var isMobile = window.matchMedia('(max-width: 768px)').matches;

	function initScrollAnimations() {
		var animatedElements = document.querySelectorAll('[data-aos]');

		if (isMobile) {
			// On mobile, just show all elements without animation
			animatedElements.forEach(function(el) {
				el.classList.add('aos-animate');
			});
			return;
		}

		var observer = new IntersectionObserver(function(entries) {
			entries.forEach(function(entry) {
				if (entry.isIntersecting) {
					entry.target.classList.add('aos-animate');
					observer.unobserve(entry.target);
				}
			});
		}, {
			threshold: 0.1,
			rootMargin: '-40px 0px'
		});

		animatedElements.forEach(function(el) {
			observer.observe(el);
		});
	}

	/*========================================
		Smooth Scroll
	==========================================*/
	function initSmoothScroll() {
		document.querySelectorAll('a[data-scroll]').forEach(function(anchor) {
			anchor.addEventListener('click', function(e) {
				e.preventDefault();
				var targetId = this.getAttribute('href');
				var targetElement = document.querySelector(targetId);
				
				if (targetElement) {
					targetElement.scrollIntoView({
						behavior: 'smooth',
						block: 'start'
					});
				}
			});
		});
	}

	/*========================================
		Adjust Menu Button's Color
	==========================================*/
	function initMenuButtonColor() {
		var mainSection = document.querySelector('.main-section');
		var body = document.body;
		var menuBtn = document.querySelector('.menu-btn');
		
		if (!mainSection || !menuBtn) return;
		
		var c_height = mainSection.offsetHeight - 40;

		function adjustColor() {
			if (window.pageYOffset >= c_height) {
				menuBtn.classList.remove('white-btn');
			} else {
				menuBtn.classList.add('white-btn');
			}
		}

		adjustColor();

		window.addEventListener('resize', function() {
			c_height = mainSection.offsetHeight - 40;
		});

		window.addEventListener('scroll', adjustColor);
	}

	/*========================================
		Menu Functions
	==========================================*/
	function initMenu() {
		var body = document.body;
		var menuBtn = document.querySelector('.menu-btn');
		var menuLinks = document.querySelectorAll('.menu li > a');

		if (menuBtn) {
			menuBtn.addEventListener('click', function(e) {
				e.preventDefault();
				body.classList.toggle('show-menu');
				
				// Update aria-expanded for accessibility
				var isExpanded = body.classList.contains('show-menu');
				menuBtn.setAttribute('aria-expanded', isExpanded);
			});
		}

		menuLinks.forEach(function(link) {
			link.addEventListener('click', function() {
				body.classList.remove('show-menu');
				if (menuBtn) {
					menuBtn.setAttribute('aria-expanded', 'false');
				}
			});
		});
	}

	/*========================================
		Material Design Ripples
	==========================================*/
	function initRipples() {
		if (typeof Waves !== 'undefined') {
			Waves.attach('.btn-custom, .menu li > a', 'waves-classic');
			Waves.init();
		}
	}

	/*========================================
		Color Theme Demo Code
	==========================================*/
	function initColorTheme() {
		var body = document.body;
		
		if (typeof Storage !== 'undefined') {
			var color = window.localStorage.getItem('color');
			
			if (color !== null) {
				body.classList.add(color);
			}
		}

		var colorSwitches = document.querySelectorAll('.color-switch > a');
		colorSwitches.forEach(function(switchBtn) {
			switchBtn.addEventListener('click', function(e) {
				e.preventDefault();
				
				var color = this.className.replace('c-', '');
				
				if (typeof Storage !== 'undefined') {
					window.localStorage.setItem('color', color);
				}

				body.classList.remove('pink', 'green', 'blue', 'teal', 'blue-grey', 'default', 'purple');
				body.classList.add(color);
			});
		});
	}

	/*========================================
		Initialize All Functions
	==========================================*/
	function init() {
		initDarkMode();
		initScrollAnimations();
		initSmoothScroll();
		initMenuButtonColor();
		initMenu();
		initRipples();
		initColorTheme();
	}

	// Initialize on DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
