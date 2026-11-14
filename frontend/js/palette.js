// Colour-blind-safe categorical colours (Okabe-Ito, black omitted for dark surfaces).
export const DET_COLORS = [null, '#56B4E9', '#009E73', '#F0E442', '#E69F00', '#D55E00', '#CC79A7'];
export const EPOCH_COLORS = ['#56B4E9', '#E69F00', '#CC79A7', '#009E73', '#F0E442', '#D55E00', '#B8C0CC', '#8da0ff'];
export const epochColor = (n) => EPOCH_COLORS[(n - 1) % EPOCH_COLORS.length];
