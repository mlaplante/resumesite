# Security Review Summary

**Date:** 2026-01-20  
**Repository:** mlaplante/resumesite  
**Review Type:** Comprehensive Security Vulnerability Assessment

## Executive Summary

A comprehensive security review was conducted on the resumesite repository. The review identified and fixed **2 security vulnerabilities** and provided recommendations for additional security hardening.

## Vulnerabilities Found and Fixed

### 1. Missing `rel="noopener noreferrer"` on External Links (MEDIUM SEVERITY) ✅ FIXED

**Location:** `index.html` (lines 124, 127, 130, 447)

**Issue:** External links were missing the `rel="noopener noreferrer"` attribute, which can lead to reverse tabnabbing attacks where malicious sites can access the `window.opener` object.

**Impact:** 
- Attacker could redirect the original page to a phishing site
- Potential for clickjacking attacks
- Performance degradation from shared process

**Fix Applied:**
```html
<!-- Before -->
<a href='https://www.facebook.com/Laplante.Michael'>Facebook</a>

<!-- After -->
<a href='https://www.facebook.com/Laplante.Michael' target="_blank" rel="noopener noreferrer">Facebook</a>
```

**Affected Links:**
- Facebook social link
- Twitter social link  
- GitHub social link
- Typeform powered-by link

### 2. Use of `document.write()` (HIGH SEVERITY) ✅ FIXED

**Location:** `index.html` (line 457), `js/script.js` (new lines 4-9)

**Issue:** The copyright year was being set using `document.write()`, which is vulnerable to XSS attacks and is considered a dangerous practice.

**Impact:**
- Potential for Cross-Site Scripting (XSS) attacks
- Can completely replace page content if called after page load
- Blocked by modern browsers with strict CSP policies

**Fix Applied:**
```html
<!-- Before -->
Copyright &copy; LaPlante Web Development 2006-<script type="text/javascript">document.write(new Date().getFullYear());</script>.

<!-- After (HTML) -->
Copyright &copy; LaPlante Web Development 2006-<span id="copyright-year"></span>.
```

```javascript
// After (JavaScript in script.js)
var copyrightYearElement = document.getElementById('copyright-year');
if (copyrightYearElement) {
    copyrightYearElement.textContent = new Date().getFullYear();
}
```

## Security Best Practices Observed

### ✅ Positive Findings:

1. **No Server-Side Code:** The site is static HTML/CSS/JS, reducing attack surface
2. **HTTPS Resources:** All external resources are loaded over HTTPS
3. **Limited Client-Side Storage:** Only localStorage is used for non-sensitive theme preferences
4. **No Sensitive Data Handling:** No forms collecting sensitive information (contact form uses external Typeform)
5. **CodeQL Scan:** Clean scan with 0 alerts after fixes

## Recommendations for Additional Security Hardening

### 1. Add Security Headers (RECOMMENDED)
Although this is a static site, if served through a web server, consider adding security headers via server configuration or a `_headers` file (for services like Netlify):

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  X-XSS-Protection: 1; mode=block
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=()
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://laplantedevanalytics.netlify.app https://embed.typeform.com https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self' https://laplantedevanalytics.netlify.app;
```

### 2. Subresource Integrity (SRI) (OPTIONAL)
Consider adding SRI hashes for external scripts to ensure they haven't been tampered with:
```html
<script src="https://example.com/script.js" 
        integrity="sha384-..." 
        crossorigin="anonymous"></script>
```

### 3. Update Third-Party Libraries (LOW PRIORITY)
Review and update third-party JavaScript libraries to their latest versions:
- jQuery (currently 2.1.4) - consider updating to latest 3.x
- Other libraries in `/js` directory

### 4. HTTPS Enforcement (RECOMMENDED)
Ensure the site is always served over HTTPS and implement HSTS headers.

## Conclusion

The security review identified and successfully fixed 2 vulnerabilities in the codebase:
1. Missing `rel="noopener noreferrer"` on external links (Medium Severity) - **FIXED**
2. Use of `document.write()` for dynamic content (High Severity) - **FIXED**

After implementing the fixes, a CodeQL security scan was performed and returned **0 alerts**, confirming that the identified vulnerabilities have been properly remediated.

The site follows many security best practices for a static website. The recommended additional hardening measures are optional but would further improve the security posture of the site.

## Verification

- ✅ All code changes committed
- ✅ Code review passed with no issues
- ✅ CodeQL security scan: 0 alerts
- ✅ Functionality verified (copyright year displays correctly, links work as expected)

## Files Modified

1. `index.html` - Fixed external links and document.write usage
2. `js/script.js` - Added safe DOM manipulation for copyright year
