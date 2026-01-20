# Michael LaPlante - Personal Portfolio & Resume Website

[![Deployment status from DeployBot](https://laplantedev.deploybot.com/badge/23779030130580/210748.svg)](https://deploybot.com)

A modern, responsive personal portfolio website showcasing Michael LaPlante's professional experience, skills, and services as a Software Engineer, VP of Technology, and Chief Security Officer.

🌐 **Live Site:** [michaellaplante.com](https://michaellaplante.com)

## 📋 Table of Contents

- [About](#about)
- [Features](#features)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Deployment](#deployment)
- [Sections Overview](#sections-overview)
- [Analytics & Tracking](#analytics--tracking)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

## 🎯 About

This website serves as a comprehensive digital resume and portfolio for Michael LaPlante, highlighting over 15 years of professional experience in software engineering, web design, and technology leadership. The site is designed to:

- **Showcase Professional Experience**: Display a detailed timeline of career progression from Web Designer to SVP of Information Security and Operations
- **Highlight Technical Skills**: Present expertise across multiple programming languages, frameworks, and design tools
- **Present Services**: Communicate available consulting and development services
- **Enable Contact**: Provide an easy way for potential clients and collaborators to get in touch
- **Demonstrate Expertise**: Serve as a live example of front-end development and UX design capabilities

## ✨ Features

- **Responsive Design**: Fully responsive layout that works seamlessly across desktop, tablet, and mobile devices
- **Modern UI/UX**: Clean, professional interface with smooth animations and transitions
- **Animated Sections**: Scroll-based animations using AOS (Animate On Scroll) library
- **Interactive Navigation**: Smooth scrolling navigation with mobile-friendly hamburger menu
- **Skills Visualization**: Progress bars showing proficiency levels in various technologies
- **Professional Timeline**: Chronological display of work experience with detailed descriptions
- **Contact Form Integration**: Embedded Typeform for easy communication
- **Performance Optimized**: Preloader for smooth initial page load
- **SEO Optimized**: Meta tags and structured content for search engine visibility
- **Analytics Integration**: Custom analytics tracking and Google Analytics integration
- **Social Media Links**: Direct links to professional social media profiles

## 🛠 Technology Stack

### Frontend Framework & Libraries
- **HTML5**: Semantic markup structure
- **CSS3**: Modern styling with custom properties
- **Bootstrap 3**: Responsive grid system and components
- **JavaScript/jQuery**: Interactive functionality and DOM manipulation

### UI Components & Effects
- **AOS (Animate On Scroll)**: Scroll-triggered animations
- **Owl Carousel**: Touch-enabled carousels
- **Waves**: Material Design ripple effects
- **Linea Icons**: Line-style icon set
- **Ionicons**: Icon font library

### Third-Party Integrations
- **Typeform**: Contact form integration
- **Google Analytics**: User tracking and analytics
- **Custom Analytics**: Self-hosted analytics solution
- **Cloudinary**: Image hosting and optimization

### Development Tools
- **DeployBot**: Continuous deployment
- **Git**: Version control
- **Custom Domain**: michaellaplante.com

## 📁 Project Structure

```
resumesite/
│
├── index.html              # Main HTML file
├── README.md              # This file
├── CNAME                  # Custom domain configuration
├── SECURITY_REVIEW.md     # Security review documentation
├── favicon.ico            # Website favicon
│
├── css/                   # Stylesheets
│   ├── style.css         # Main custom styles
│   ├── linea.css         # Linea icons styles
│   ├── ionicons.min.css  # Ionicons styles
│   ├── waves.min.css     # Waves effect styles
│   ├── owl.carousel.css  # Carousel styles
│   └── aos.css           # Animation on scroll styles
│
├── js/                    # JavaScript files
│   ├── script.js         # Main custom JavaScript
│   ├── jquery.min.js     # jQuery library
│   ├── smooth-scroll.min.js  # Smooth scrolling
│   ├── jquery.shuffle.min.js # Shuffle plugin
│   ├── waves.min.js      # Material waves effect
│   ├── owl.carousel.min.js   # Carousel functionality
│   ├── validator.min.js  # Form validation
│   └── aos.js            # Animate on scroll
│
├── bootstrap/             # Bootstrap framework
│   └── css/
│       └── bootstrap.min.css
│
├── fonts/                 # Icon and custom fonts
│
└── img/                   # Image assets
    └── loader.gif        # Page preloader animation
```

## 🚀 Getting Started

### Prerequisites

- A modern web browser (Chrome, Firefox, Safari, or Edge)
- A local web server (optional, for development)
- Git (for cloning the repository)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/mlaplante/resumesite.git
   cd resumesite
   ```

2. **Open locally**
   
   Simply open `index.html` in your web browser, or use a local development server:

   **Using Python:**
   ```bash
   # Python 3
   python -m http.server 8000
   
   # Python 2
   python -m SimpleHTTPServer 8000
   ```

   **Using Node.js (http-server):**
   ```bash
   npx http-server -p 8000
   ```

3. **View the site**
   
   Open your browser and navigate to `http://localhost:8000`

### Making Changes

1. Edit `index.html` to update content
2. Modify files in `css/` to change styling
3. Update `js/script.js` for custom JavaScript functionality
4. Test changes in your local browser
5. Commit and push changes to trigger automatic deployment via DeployBot

## 🚢 Deployment

This site is automatically deployed using **DeployBot** whenever changes are pushed to the repository. The deployment status badge at the top of this README shows the current deployment state.

### Deployment Process

1. Push changes to the repository
2. DeployBot automatically detects changes
3. Site is deployed to the hosting server
4. Changes are live at [michaellaplante.com](https://michaellaplante.com)

### Custom Domain

The site uses a custom domain configured via the `CNAME` file. DNS is configured to point `michaellaplante.com` to the hosting server.

## 📄 Sections Overview

### Home
- Eye-catching hero section with personal photo
- Name and title introduction
- Clean, minimalist design

### About Me
- Professional summary and introduction
- Background and experience overview
- Social media links (Facebook, Twitter, GitHub)

### Fun Facts
- Statistical highlights (clients served, languages mastered, speaking sessions)
- Visual representation of achievements
- Engaging metrics display

### Services
- **Programming**: Custom software development
- **Creative**: Design and UX services
- **Consulting**: Technology consulting and strategy
- **SEO**: Search engine optimization services

### Skills
- Visual skill bars showing proficiency levels
- Technologies covered:
  - Adobe Design Suite (99%)
  - HTML/CSS/Sass (99%)
  - JavaScript (98%)
  - jQuery (100%)
  - React (90%)
  - Angular (90%)
  - TypeScript (90%)

### Experience
- Detailed chronological timeline of professional positions
- Company names, titles, and date ranges
- Comprehensive job descriptions
- Covers 15+ years of experience from 2010 to present
- Notable positions:
  - Proforma - SVP of Information Security and Operations (2026-Present)
  - Proforma - Vice President of Technology (2022-2026)
  - FireEye - Senior Web Engineer (2015-2019)
  - And more...

### Contact
- Embedded Typeform for easy communication
- Streamlined contact process
- Professional inquiry handling

## 📊 Analytics & Tracking

The site implements multiple analytics solutions:

1. **Custom Analytics**: Self-hosted analytics via `laplantedevanalytics.netlify.app`
   - Website ID: `1432237e-7cf8-4b54-9b2d-2f8f5bde6e7c`

2. **Google Analytics**: 
   - Tracking ID: `G-8NYWNGQRKS`
   - Comprehensive user behavior tracking

## 🤝 Contributing

This is a personal portfolio website. However, if you find bugs or have suggestions for improvements:

1. Open an issue describing the problem or suggestion
2. If you'd like to contribute code:
   - Fork the repository
   - Create a feature branch (`git checkout -b feature/improvement`)
   - Make your changes
   - Test thoroughly
   - Commit your changes (`git commit -am 'Add improvement'`)
   - Push to the branch (`git push origin feature/improvement`)
   - Open a Pull Request

## 📝 License

Copyright © LaPlante Web Development 2006-2026. All rights reserved.

This is a personal portfolio website. Please do not copy or redistribute without permission.

## 📧 Contact

**Michael LaPlante**

- **Website**: [michaellaplante.com](https://michaellaplante.com)
- **GitHub**: [@mlaplante](https://github.com/mlaplante)
- **Twitter**: [@laplantewebdev](https://twitter.com/laplantewebdev)
- **Facebook**: [Laplante.Michael](https://www.facebook.com/Laplante.Michael)

For professional inquiries, please use the contact form on the website.

---

**Built with ❤️ by Michael LaPlante**
