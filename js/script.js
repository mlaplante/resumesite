/*========================================
	Set Copyright Year
==========================================*/
(function() {
	var copyrightYearElement = document.getElementById('copyright-year');
	if (copyrightYearElement) {
		copyrightYearElement.textContent = new Date().getFullYear();
	}
})();

/*========================================
	Native Scroll Animations (replaces AOS.js)
==========================================*/
(function() {
	'use strict';

	// Skip animations on mobile for performance
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

	// Initialize on DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initScrollAnimations);
	} else {
		initScrollAnimations();
	}
})();

$(function(){
	'use strict';

	/*========================================
		SmoothScroll
	==========================================*/
	smoothScroll.init({
		updateURL: false
	});

	/*========================================
		Adjust Menu Button's Color
	==========================================*/
	var c_height = $('.main-section').outerHeight() - 40,
		$body = $('body'),
		$menu_btn = $('.menu-btn');
	function menu_btn_color(){
		if( $(window).scrollTop() >= c_height ){
			$menu_btn.removeClass('white-btn');
		}else{
			$menu_btn.addClass('white-btn');
		}
	}
	menu_btn_color();

	$(window).on('resize', function(){

		c_height = $('.main-section').outerHeight() - 40;

	}).on('load', function(){

		/*========================================
			Testimonials Slider
		==========================================*/
		$('.testimonials-slider').owlCarousel({
			items: 1
		});

		/*========================================
			Project Images Slider
		==========================================*/
		$('.project-slider').owlCarousel({
			items: 1,
			autoHeight: true
		});

		/*========================================
			Portfolio Items
		==========================================*/
		$('.portfolio-items').shuffle();

	}).on('scroll', function(){

		menu_btn_color();

	});

	/*========================================
		Material Design Ripples
	==========================================*/
	Waves.attach('.btn-custom, .menu li > a', 'waves-classic');
	Waves.init();

	/*========================================
		Material Design Textbox
	==========================================*/
	$('.material-input > .form-control').blur(function() {
		if ($(this).val()){
			$(this).addClass('used');
		}else{
			$(this).removeClass('used');
		}
	});

	/*========================================
		Portfolio Items Ripple Effect
	==========================================*/
	$('.portfolio-items > li > .inner').each(function(){
		var $this = $(this),
			_w = $this.outerWidth(),
			_h = $this.outerHeight(),
			_s = _w > _h ? _w : _h,
			_s = _s * 2.6;
		$this.append('<div class="ripple" ></div>');
		$this.find('.ripple').css({
			height: _s,
			width: _s
		});
	}).on('mouseenter', function(e){
		var $this = $(this),
			_s = parseInt($this.find('.ripple').css('height')),
			_offset = $this.offset(),
			_x = e.pageX - $this.offset().left,
			_y = e.pageY - $this.offset().top,
			_x = _x - (_s/2),
			_y = _y - (_s/2);
		$this.find('.ripple').css({
			'top': _y,
			'left': _x
		});
	});

	/*========================================
		Menu Functions
	==========================================*/
	$menu_btn.on('click', function(e){
		e.preventDefault();
		$body.toggleClass('show-menu');
		// Update aria-expanded for accessibility
		var isExpanded = $body.hasClass('show-menu');
		$menu_btn.attr('aria-expanded', isExpanded);
	});
	$('.menu li > a').on('click', function(e){
		$body.removeClass('show-menu');
	});


	/*=========================================================================
		Contact Form (NOT WORKING IN DEMO ONLY)
	=========================================================================*/
	$('#contact-form').validator().on('submit', function (e) {
		if (!e.isDefaultPrevented()) {
			e.preventDefault();
			var $this = $(this),
				//You can edit alerts here
				alerts = {
					success:
					"<div class='form-group' >\
						<div class='alert alert-success' role='alert'> \
							<strong>Message Sent!</strong> We'll be in touch as soon as possible\
						</div>\
					</div>",
					error:
					"<div class='form-group' >\
						<div class='alert alert-danger' role='alert'> \
							<strong>Oops!</strong> Sorry, an error occurred. Try again.\
						</div>\
					</div>"
				};
			$('#contact-form-result').html(alerts.success);
			$('#contact-form').trigger('reset');
			$('#contact-form .used').removeClass('used');
		}
	});


	// Demo Code
	if( typeof Storage != 'undefined' ){

		var color = window.localStorage.getItem('color');

		if(color != null ){
			$body.addClass(color);
		}

	}
	$('.color-switch > a').on('click', function(e){

		e.preventDefault();

		color = this.className.replace('c-', '');

		if( typeof Storage != 'undefined' ){
			window.localStorage.setItem('color', color);
		}


		$body.removeClass('pink green blue teal blue-grey default purple');

		$body.addClass(color);

	});

});
