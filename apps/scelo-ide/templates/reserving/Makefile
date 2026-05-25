# Reserving starter — three-step run via a single command.
#
# `make` runs the canonical pipeline (R Mack -> Python verify); `make
# report` produces a paste-into-PR markdown summary.

.PHONY: all report clean

all: data/mack_results.json
	python python/verify.py

data/mack_results.json:
	Rscript r/mack_raa.R

report: data/mack_results.json
	@mkdir -p out
	@printf "# RAA Mack chain-ladder\n\n" > out/report.md
	@printf '```json\n' >> out/report.md
	@cat data/mack_results.json >> out/report.md
	@printf '\n```\n' >> out/report.md
	@printf "\nCross-checked against chainladder.py:\n\n" >> out/report.md
	@printf '```\n' >> out/report.md
	@python python/verify.py >> out/report.md 2>&1
	@printf '\n```\n' >> out/report.md
	@echo wrote out/report.md

clean:
	rm -rf data/mack_results.json out
