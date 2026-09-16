# PROJECT SYNOPSIS: FindIt - Smart Campus Lost and Found Management System

## 1. Introduction
FindIt is a full-stack campus lost-and-found management system. It replaces informal reporting methods with a centralized, searchable platform that ranks likely matches and provides a secure coordinator workflow.

## 1.3 Architecture
FindIt utilizes a client-server architecture.
- **Frontend:** Responsive web application (HTML5, CSS3, vanilla JavaScript) communicating with the backend.
- **Backend:** C++ REST server utilizing SQLite for robust, centralized data storage.
- **Data Policy:** The system enforces a 7-day data retention policy. Records are automatically purged after 7 days to maintain privacy and relevance.

## 1.4 Admin & Verification Workflow
The system includes a secure Admin/Coordinator portal. 
- **Admin Authentication:** Secure login required to access management functions.
- **Verification:** Admins can manually verify returned or claimed items.
- **Workflow:** Admins track status transitions (Open, Possible Match, Claimed, Returned) to ensure accurate record-keeping.

## 1.6 Core Matching Algorithm
FindIt retains its explainable, transparent weighted scoring method:
- **Weights:** Category, colour, location, date, and description tokens.
- **Normalisation:** Token-based similarity handles synonyms (e.g., "earbuds" vs "earphones").
- **Transparency:** The system displays the reason for each ranking, ensuring users understand why items are suggested as matches.
