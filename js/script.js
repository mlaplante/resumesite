/*-----------------------------------------------------------------------------------
/*
/* Script for Resume
/*
-----------------------------------------------------------------------------------*/

/*----------------------------------------------------*/
/* Preloader
------------------------------------------------------ */

$(window).load(function() {

    $('.loader').fadeOut();
    $('#preloader').delay(350).fadeOut('slow');
    $('body').delay(350);

});


jQuery(document).ready(function($) {

    /*----------------------------------------------------*/
    /* Initializing jQuery Nice Scroll
    ------------------------------------------------------ */

    $("html").niceScroll({
        cursorcolor: "#11abb0", // Set cursor color
        cursorwidth: "8", // Sety cursor width
        cursorborder: "" // Set cursor border color, default left none
    });


    /*----------------------------------------------------*/
    /* FitText Settings
    ------------------------------------------------------ */

    setTimeout(function() {
        $('h1.responsive-headline').fitText(1, {
            minFontSize: '28px',
            maxFontSize: '72px'
        });
    }, 100);


    /*----------------------------------------------------*/
    /* Smooth Scrolling
    ------------------------------------------------------ */

    $('.smoothscroll').on('click', function(e) {
        e.preventDefault();

        var target = this.hash,
            $target = $(target);

        $('html, body').stop().animate({
            'scrollTop': $target.offset().top
        }, 800, 'swing', function() {
            window.location.hash = target;
        });

    });


    /*----------------------------------------------------*/
    /* Appear Animation
    ------------------------------------------------------*/
    new WOW().init();

    /*----------------------------------------------------*/
    /* Parallax for Header Content
    ------------------------------------------------------*/
    $(window).scroll(function(e) {
        parallax();
    });


    function parallax() {
        var scrollPosition = $(window).scrollTop();
        $('.banner').css('margin-top', (0 - (scrollPosition * .8)) + 'px');
    }

    /*----------------------------------------------------*/
    /* Highlight the current section in the navigation bar
    ------------------------------------------------------*/

    var sections = $("section");
    var navigation_links = $("#m-nav a");

    sections.waypoint({

        handler: function(event, direction) {

            var active_section;

            active_section = $(this);
            if (direction === "up") active_section = active_section.prev();

            var active_link = $('#m-nav a[href="#' + active_section.attr("id") + '"]');

            navigation_links.parent().removeClass("current");
            active_link.parent().addClass("current");

        },
        offset: '35%'

    });


    /*----------------------------------------------------*/
    /*  Make sure that #header-background-image height is
    /* equal to the browser height.
    ------------------------------------------------------ */

    $('header').css({
        'height': $(window).height()
    });
    $(window).on('resize', function() {

        $('header').css({
            'height': $(window).height()
        });
        $('body').css({
            'width': $(window).width()
        })
    });


    /*----------------------------------------------------*/
    /*  On scroll blur header
    ------------------------------------------------------*/
    (function() {
        $(window).scroll(function() {
            var oVal;
            oVal = $(window).scrollTop() / 100;
            return $(".header-overlay").css("opacity", oVal);
        });

    }).call(this);



    /*----------------------------------------------------*/
    /*  Fade In/Out Primary Navigation
    ------------------------------------------------------*/

    $(window).on('scroll', function() {

        var h = $('header').height();
        var y = $(window).scrollTop();
        var nav = $('#m-nav');

        if ((y > h * .20) && (y < h) && ($(window).outerWidth() > 768)) {
            nav.fadeOut('fast');
        } else {
            if (y < h * .20) {
                nav.removeClass('opaque').fadeIn('fast');
            } else {
                nav.addClass('opaque').fadeIn('fast');
            }
        }

    });


    /*----------------------------------------------------*/
    /*  Modal Popup
    ------------------------------------------------------*/

    $('.item-wrap a').magnificPopup({

        type: 'inline',
        fixedContentPos: false,
        removalDelay: 200,
        showCloseBtn: false,
        mainClass: 'mfp-fade'

    });

    $(document).on('click', '.popup-modal-dismiss', function(e) {
        e.preventDefault();
        $.magnificPopup.close();
    });


    /*----------------------------------------------------*/
    /*  Owl Carousel
    /*----------------------------------------------------*/


    $(document).ready(function() {

        $("#testimonial-slides").owlCarousel({

            navigation: false, // Show next and prev buttons
            slideSpeed: 300,
            paginationSpeed: 400,
            singleItem: true

            // "singleItem:true" is a shortcut for:
            // items : 1,
            // itemsDesktop : false,
            // itemsDesktopSmall : false,
            // itemsTablet: false,
            // itemsMobile : false

        });

    });


    /*----------------------------------------------------*/
    /*  Google Map
    ------------------------------------------------------*/

    // main directions
    // map = new GMaps({
    //   el: '#map', lat: 23.790223, lng: 90.414036, zoom: 13, zoomControl : true, 
    //   zoomControlOpt: { style : 'SMALL', position: 'TOP_LEFT' }, panControl : false, scrollwheel: false
    // });
    // add address markers
    // map.addMarker({ lat: 23.790223, lng: 90.414036, title: 'BD InfoSys',
    //   infoWindow: { content: '<p>Building # 2, Plot # 111, Road # 35, Gulshan - 2, Dhaka</p>' } });

    /*----------------------------------------------------*/
    /*  contact form
    ------------------------------------------------------*/

    // Get the form.
    var form = $('#contactForm');

    // Get the messages div.
    var formMessages = $('#form-messages');

    // Set up an event listener for the contact form.
    $(form).submit(function(e) {
        // Stop the browser from submitting the form.
        e.preventDefault();

        // Serialize the form data.
        var formData = $(form).serialize();

        // Submit the form using AJAX.
        $.ajax({
                type: 'POST',
                url: $(form).attr('action'),
                data: formData
            })
            .done(function(response) {
                // Make sure that the formMessages div has the 'success' class.
                $(formMessages).removeClass('error');
                $(formMessages).addClass('success');

                // Set the message text.
                $(formMessages).text(response);

                // Clear the form.
                $('#name').val('');
                $('#email').val('');
                $('#subject').val('');
                $('#message').val('');
            })
            .fail(function(data) {
                // Make sure that the formMessages div has the 'error' class.
                $(formMessages).removeClass('success');
                $(formMessages).addClass('error');

                // Set the message text.
                if (data.responseText !== '') {
                    $(formMessages).text(data.responseText);
                } else {
                    $(formMessages).text('Oops! An error occured and your message could not be sent.');
                }
            });

    });


});