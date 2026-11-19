# Licence and credits: galaxies data

Applies to **every file in `frontend/data/objects/galaxies/`**:

- `manifest.json`;
- `tiles/*.json`, the galaxy records;
- this file.

## Licence

These files are derived from OpenNGC: its galaxies, coordinates, sizes, magnitudes, velocities, names and identifiers were merged with UNGC (by identifier, a committed override table and position), given distances, and converted to Space Maps' record format. The OpenNGC-derived values are licensed under the same CC BY-SA 4.0 licence; the exceptions are below.

The OpenNGC data, and the data derived from it, are licensed under **CC BY-SA 4.0**
(https://creativecommons.org/licenses/by-sa/4.0/).

Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC

OpenNGC is at https://github.com/mattiaverga/OpenNGC, release v20260501, commit `36cb178a0f69dba8bfc03a99c10512831edf1c6b`. Changes made here: the rows of the types
G, GPair, GTrpl and GGroup were selected, merged with UNGC, given distances and re-encoded as JSON records (see
`docs/object-framework.md`, section 18).

## Values with other terms

Nothing here is relicensed: each value keeps the terms of its source, named in its `src`.

- **Cosmicflows-4 / EDD-terms values.** Every distance whose `src` says "Cosmicflows-4" (the per-method moduli
  converted to comoving distances, and the CF4 group distances of the Virgo, Fornax, Coma and Perseus clusters) comes
  from Tully et al. 2023, which the Extragalactic Distance Database (https://edd.ifa.hawaii.edu/) distributes under its terms: use,
  analysis and sharing for research and education, provided EDD is cited; changed, converted or combined data must
  say so and must not be presented as EDD data. These values are converted by Space Maps (the `src` says so) and are
  not EDD data. They are **not** under CC BY-SA 4.0. Cite Tully et al. 2009, AJ 138, 323 alongside the paper.
- **UNGC and McConnachie values**, served by VizieR (CDS), keep VizieR's terms of use (https://cds.unistra.fr/vizier-org/licences_vizier.html) with the
  citations below.
- **Hubble-flow distances and the cluster rule** are computed by Space Maps from OpenNGC (or UNGC) velocities and
  the Planck 2018 dipole; the cluster distances use the CF4 groups table.
- **The Milky Way record** copies Sgr A*'s position and distance from the black-hole source file (GRAVITY
  Collaboration 2022; Reid & Brunthaler) and holds Bland-Hawthorn & Gerhard 2016 and Hipparcos values, each cited in
  its `src`.

There are no Gaia values in these files.

## OpenNGC acknowledgements

OpenNGC has been built by merging data from:

- NASA/IPAC Extragalactic Database, http://ned.ipac.caltech.edu/
  This research has made use of the NASA/IPAC Extragalactic Database (NED) which is operated by the Jet Propulsion
  Laboratory, California Institute of Technology, under contract with the National Aeronautics and Space
  Administration.
- HyperLEDA database, http://leda.univ-lyon1.fr
  We acknowledge the usage of the HyperLeda database (http://leda.univ-lyon1.fr)
- SIMBAD Astronomical Database, http://simbad.u-strasbg.fr/simbad/
  This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France
- HEASARC High Energy Astrophysics Science Archive Research Center, http://heasarc.gsfc.nasa.gov/
  We used several databases from HEASARC such as messier, mwsc, lbn, plnebulae, lmcextobj and smcclustrs.
- Harold Corwin's NGC/IC Positions and Notes, http://haroldcorwin.net/ngcic/index.html

Some common names are taken from internet sources like Wikipedia.

## Other catalogues

- Karachentsev I. D., Makarov D. I., Kaisina E. I., 2013, AJ 145, 101: Updated Nearby Galaxy Catalog (arXiv:1303.5328), doi:10.26093/cds/vizier.51450101, VizieR J/AJ/145/101
- Tully R. B., Courtois H. M., Sorce J. G., 2023, ApJ 944, 94: Cosmicflows-4 (arXiv:2209.11238), VizieR J/ApJ/944/94; Extragalactic Distance Database: Tully R. B. et al., 2009, AJ 138, 323
- McConnachie A. W., 2012, AJ 144, 4: The Observed Properties of Dwarf Galaxies in and around the Local Group (arXiv:1204.1562), VizieR J/AJ/144/4

VizieR terms of use: https://cds.unistra.fr/vizier-org/licences_vizier.html

## Code

The code that builds these files (`backend/scripts/build_objects_galaxies.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`). Only the data files listed above carry the terms named here.
