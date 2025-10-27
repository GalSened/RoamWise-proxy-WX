# ⚠️ DEPRECATED - Repository Consolidated

**This repository is no longer actively maintained.**

All development has moved to the unified RoamWise monorepo:  
**https://github.com/GalSened/RoamWise**

## What Happened?

On October 24, 2025, we consolidated 5 separate RoamWise repositories into a single monorepo for better:
- Dependency management (npm workspaces)
- Cross-component development
- CI/CD integration
- Version control

## New Repository Structure

The monorepo contains all components:
- `frontend/` (formerly RoamWise-frontend-WX)
- `backend/` (formerly roamwise-backend-v2)
- `proxy/` (formerly **RoamWise-proxy-WX** - this repo)
- `ai/` (formerly RoamWise-PersonalAI)
- `routing/` (OSRM routing data with Git LFS)

## Migration

To continue development:

1. **Clone the monorepo**:
   ```bash
   git clone https://github.com/GalSened/RoamWise.git
   cd RoamWise
   ```

2. **Install dependencies**:
   ```bash
   git lfs pull  # Fetch routing data
   npm install   # Install all workspace dependencies
   ```

3. **Proxy development**:
   ```bash
   npm run dev:proxy
   # Or work directly in the proxy/ directory
   cd proxy && npm run dev
   ```

## Archives

This repository has been archived and is now read-only. All issues, pull requests, and discussions should be directed to the new monorepo.

For migration details, see:
- [Migration Guide](https://github.com/GalSened/RoamWise/blob/main/MIGRATION.md)
- [Migration Complete Summary](https://github.com/GalSened/RoamWise/blob/main/MIGRATION_COMPLETE.md)

---

**Archived**: October 24, 2025  
**New Repository**: https://github.com/GalSened/RoamWise
