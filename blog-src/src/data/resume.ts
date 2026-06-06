// Single source of truth for résumé-style content shared by the homepage
// (index.astro) and the printable résumé page (resume.astro). Update a job,
// skill, or stat here once and both pages stay in sync — there is no separate
// résumé file to hand-maintain.

export interface ProfileLink {
  label: string;
  url: string;
}

export const profile = {
  name: 'Michael LaPlante',
  title: 'SVP of Information Security and Operations',
  website: 'michaellaplante.com',
  websiteUrl: 'https://michaellaplante.com',
  links: [
    { label: 'LinkedIn', url: 'https://www.linkedin.com/in/mlaplante/' },
    { label: 'Facebook', url: 'https://www.facebook.com/Laplante.Michael' },
    { label: 'Twitter', url: 'https://twitter.com/laplantewebdev' },
    { label: 'Github', url: 'https://github.com/mlaplante' },
  ] satisfies ProfileLink[],
};

// Each paragraph of the "About Me" summary. The first renders larger on the
// homepage; the résumé uses them as the professional summary.
export const summary = [
  "I'm an accomplished technology executive with comprehensive expertise in cybersecurity strategy, enterprise operations, and innovative software engineering.",
  "With over 15 years of distinguished professional experience, I spearhead mission-critical technology initiatives as SVP of Information Security and Operations, delivering measurable impact across complex enterprise environments. My career trajectory showcases proven success in software engineering excellence, advanced security architecture, strategic team leadership, and operational transformation.",
  "I architect and implement secure, scalable enterprise-grade technology solutions while cultivating high-performing teams that consistently exceed objectives and drive meaningful organizational change. My technical expertise spans multiple programming languages, and I've delivered solutions serving hundreds of satisfied clients while sharing insights through numerous speaking engagements worldwide.",
];

export interface Stat {
  value: string;
  label: string;
}

export const stats: Stat[] = [
  { value: '$800M', label: 'Company secured' },
  { value: '15+', label: 'Years in enterprise security' },
  { value: '70+', label: 'Speaking engagements' },
  { value: '500+', label: 'Clients served' },
];

export interface Skill {
  name: string;
  description: string;
}

export const skills: Skill[] = [
  { name: 'Cloud Security', description: 'AWS, Azure, GCP architecture hardening and multi-cloud governance' },
  { name: 'Zero Trust Architecture', description: 'Identity-first security models, micro-segmentation, and continuous verification' },
  { name: 'DevSecOps', description: 'Security automation in CI/CD pipelines, SAST/DAST, and supply chain security' },
  { name: 'Threat Modeling', description: 'Risk identification, attack surface analysis, and mitigation planning' },
  { name: 'AI & LLM Security', description: 'Securing generative AI workflows, prompt injection defense, and data protection' },
  { name: 'Compliance Frameworks', description: 'SOC 2, ISO 27001, HIPAA, PCI-DSS, and NIST implementation' },
  { name: 'Incident Response', description: 'IR planning, tabletop exercises, and post-incident analysis' },
  { name: 'Engineering Leadership', description: 'Scaling teams, building security culture, and technical strategy' },
  { name: 'Full-Stack Development', description: 'TypeScript, React, Angular, Node.js, and modern web architecture' },
];

export interface ExperienceEntry {
  company: string;
  role: string;
  date: string;
  current?: boolean;
  description: string;
}

export const experience: ExperienceEntry[] = [
  {
    company: 'Proforma',
    role: 'SVP of Information Security and Operations',
    date: 'January 2026 - Present',
    current: true,
    description:
      'Leading information security strategy and operational excellence across the organization. Key functions include: establishing and maintaining comprehensive security frameworks, driving compliance with industry standards and regulations, overseeing infrastructure security and risk management, leading cross-functional technology teams, implementing security best practices and policies, and fostering a culture of security awareness throughout the organization. Responsible for strategic planning, vendor management, incident response, and ensuring business continuity while aligning security initiatives with organizational goals.',
  },
  {
    company: 'Proforma',
    role: 'Vice President of Technology',
    date: 'April 2022 - January 2026',
    description:
      'Led and managed technology teams while driving security and compliance innovation across the organization. Spearheaded strategic initiatives to enhance infrastructure security, implement robust compliance frameworks, and foster a culture of continuous improvement. Oversaw cross-functional teams to deliver secure, scalable solutions that aligned with business objectives and industry best practices.',
  },
  {
    company: 'Proforma',
    role: 'Director of Engineering',
    date: 'November 2021 - April 2022',
    description:
      'I was responsible for assisting in the continued development of the companies multi-million dollar business management solution software. In my role I was tasked with leading the development teams in executing greenfield and remediation tasks, monthly trainings with team members, coaching of team leaders and providing 1-1 feedback. I was also responsible for 12 month timelines, customer relationships and support, manager training and growth.',
  },
  {
    company: 'Proforma',
    role: 'Software Development Manager',
    date: 'July 2019 - November 2021',
    description:
      'I was responsible for assisting in the continued development of the companies multi-million dollar business management solution software. In my role I was tasked with leading the development teams in executing greenfield and remediation tasks, monthly trainings with team members, coaching of team leaders and providing 1-1 feedback.',
  },
  {
    company: 'Proforma',
    role: 'Principal Engineer',
    date: 'February 2019 - July 2019',
    description:
      'I was responsible for assisting in the continued development of the companies multi-million dollar business management solution software. In my role I was tasked with leading the charge on framework decisions, implementing best practices with technologies like Angular, and teaching the entire software team of these practices.',
  },
  {
    company: 'FireEye',
    role: 'Senior Web Engineer',
    date: 'June 2015 - February 2019',
    description:
      "I was responsible for creating all Front End Development practices for Fireeye's next generation threat portal, Fireeye Intelligence Portal. This meant I worked closely with the design team and managers and stakeholders to come up with a plan and realize that plan into a web application for the company. In doing this we focused with latest technologies in HTML, Css, and Javascript with a focus on React and Redux.",
  },
  {
    company: 'Mobilozophy LLC',
    role: 'Front End Developer',
    date: 'Nov 2015 - Oct 2016',
    description:
      'I was responsible for helping to shape the mobile interfaces for many of the companies clients. This would include transitioning designs to phonegap markup and applications, or delivering content management systems to match the matching mobile designs. This was a remote job, where most communication was handled through Skype or other communication mediums.',
  },
  {
    company: 'Reboot Coding LLC',
    role: 'Lead Front End Development Instructor',
    date: 'Dec 2014 - Jun 2015',
    description:
      'I was responsible for creating the front end development curriculum and teaching the basic core principles of front end development to our students. After the base core principles are instilled I teach the more advanced front end specific related courses in the program, including Angular.js and Advanced JavaScript.',
  },
  {
    company: 'Wolters Kluwer Law & Business',
    role: 'Lead UI Developer',
    date: 'Dec 2012 - Nov 2014',
    description:
      'I worked on a small team responsible for managing all the user interface and interactions of an online web application. My day to day consists of helping to design a new concept and bring it to conception, using modern technologies like HTML5/CSS3 with a mixin of Knockout.js.',
  },
  {
    company: 'Thuzi',
    role: 'Web Designer',
    date: 'June 2011 - Dec 2012',
    description:
      'I was responsible for managing the User Interface for the companies many clients. I worked mainly with taking a photoshop mockup and converting it to a usable interface. I also dealt with writing custom markup for facebook applications.',
  },
  {
    company: 'Client Intellect',
    role: 'Web Designer',
    date: 'July 2010 - Mar 2011',
    description:
      'I was responsible for managing the companies internal systems in addition to making constant updates to their client facing websites. This job mainly focused on creating a design in photoshop and converting it to be usable on the client facing sites.',
  },
];
