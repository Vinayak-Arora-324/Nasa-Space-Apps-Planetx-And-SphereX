# Licence and credits: smbh-curated source data

Applies to **every file in `backend/data/sources/smbh-curated/`**: `smbh.json` (hand-curated) and this file.

`smbh.json` holds masses, paper distances, a ring diameter and names for eight supermassive black holes, each read from
the paper named in its `src` and `where`, as facts with their citations. It holds no OpenNGC, Cosmicflows-4, UNGC or
Gaia values: the host galaxies' positions and distances are copied at build time from the built `galaxies` dataset
(see `frontend/data/objects/galaxies/LICENSE.md` for their terms: OpenNGC CC BY-SA 4.0, Cosmicflows-4 under EDD's
research-and-education terms, UNGC via VizieR). The output dataset `frontend/data/objects/smbh-curated/` therefore mixes
those terms, named in its own `LICENSE.md`; nothing is relicensed. There are no Gaia values.

The code that builds the dataset (`backend/scripts/build_objects_smbh.py`) and the rest of the repository are under the
MIT licence (see the repository `LICENSE`).
