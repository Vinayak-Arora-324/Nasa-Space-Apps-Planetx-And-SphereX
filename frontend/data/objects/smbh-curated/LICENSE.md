# Licence and credits: smbh-curated data

Applies to every file in this folder (`manifest.json`, `tiles/*.json` and this file).

These eight supermassive black holes are placed at the centres of their host galaxies, so each record **copies its
host galaxy's position and distance** from the `galaxies` dataset. Those values keep the terms of their sources:

- **Positions** are OpenNGC's, licensed under **CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/).
  Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC (release v20260501, commit
  `36cb178a0f69dba8bfc03a99c10512831edf1c6b`). The records here are derived from those positions and are shared under
  the same licence.
- **Distances** are the host galaxies' adopted distances. Where a `src` says "Cosmicflows-4", the value comes from
  Tully et al. 2023, which the Extragalactic Distance Database (https://edd.ifa.hawaii.edu/) distributes under its
  terms: use, analysis and sharing for research and education, provided EDD is cited; the values are converted by
  Space Maps (the `src` says so) and are not EDD data. They are **not** under CC BY-SA 4.0. Cite Tully et al. 2009,
  AJ 138, 323 alongside the paper. M81's distance is UNGC's (Karachentsev et al. 2013, VizieR J/AJ/145/101), which keeps
  VizieR's terms (https://cds.unistra.fr/vizier-org/licences_vizier.html).
- **Masses, the paper distances, the M87* ring diameter and the names** are curated by hand from the published papers
  cited in `manifest.json` (`provenance.papers`) and in each value's `src`, as facts with their citations. The
  rescaled masses are computed by Space Maps from them (the `src` says so).

Nothing here is relicensed: each value keeps the terms of its source. There are no Gaia values in these files.

The code that builds them (`backend/scripts/build_objects_smbh.py`) and the rest of the repository are under the MIT
licence (see the repository `LICENSE`). Only the data files listed above carry the terms named here.
