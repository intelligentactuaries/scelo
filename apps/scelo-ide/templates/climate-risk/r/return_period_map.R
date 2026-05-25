# Render the per-centroid return-period losses as a hex-binned map.
#
# Reads data/return_periods.csv (written by python/loss.py) and produces
# return_period_100.png next to it. Single dependency: ggplot2. No tile
# layer (no offline-mode breakage); we plot the centroid grid directly
# which is enough for an "is the pattern sensible" sanity check.

suppressPackageStartupMessages({
  library(ggplot2)
})

here <- normalizePath(dirname(dirname(sys.frame(1)$ofile)))
csv_path <- file.path(here, "data", "return_periods.csv")
if (!file.exists(csv_path)) {
  stop("missing ", csv_path, ": run python/loss.py first.")
}

df <- read.csv(csv_path)
if (!"rp100" %in% names(df)) {
  stop("expected column rp100 in ", csv_path, ", got: ",
       paste(names(df), collapse = ", "))
}

p <- ggplot(df, aes(x = lon, y = lat, fill = log10(pmax(rp100, 1)))) +
  geom_tile() +
  coord_quickmap() +
  scale_fill_viridis_c(name = "log10(rp100)") +
  labs(title = "Tropical-cyclone 100-year return-period loss",
       subtitle = "US east coast, LitPop exposure, Climada engine",
       x = NULL, y = NULL) +
  theme_minimal(base_size = 11) +
  theme(legend.position = "right")

out <- file.path(here, "data", "return_period_100.png")
ggsave(out, p, width = 7, height = 4.5, dpi = 150)
cat("wrote", out, "\n")
