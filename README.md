# Emulator Fidelity Atlas

A static site that shows how much of AWS the [AWS Emulator](https://github.com/aws/aws-emulator) covers, per service and per operation:

- **Operation census.** Every operation in each service's Smithy model is classed as implemented, a 501 stub, or not routable, using the emulator's own stub marker in `src/ops/*.rs`.
- **Fidelity scores.** Every unit in the release's `scores.json.gz`, wire and behavioral, joined with the evaluation suite's `manifest.jsonl` labels (plane, data-plane path, axis, timing).
- **Gaps.** Every file in `issues/things-that-do-not-work` and `issues/things-that-now-work`.
- **Check my project.** Paste the operations your code calls (`s3:PutObject`, `aws sqs send-message`, `dynamodb.query`) to see the status of each one and its test pass rate.

The site is plain HTML, CSS and JS, with no build step and no third-party runtime dependencies.

## Automatic updates

`.github/workflows/update.yml` runs every 6 hours, on manual dispatch, and on pushes to `main`. `scripts/update.py` finds the two newest `aws/aws-emulator` releases that ship `scores.json.gz` and compares the newest with the release the live site shows. It exits early if they match. Otherwise it clones the emulator at that release tag and the evaluation suite at HEAD, rebuilds `site/data`, and deploys to GitHub Pages. To force a rebuild: Actions → Update atlas → Run workflow → force.

## Rebuild the data by hand

`python3 scripts/update.py --force` does all of the steps below. To run them individually:

```bash
git clone --depth 1 --branch v1.0.322 https://github.com/aws/aws-emulator.git src/aws-emulator
git clone --depth 1 https://github.com/aws/aws-emulator-evaluation-suite.git src/aws-emulator-evaluation-suite
mkdir -p raw
for t in v1.0.322 v1.0.293; do
  gh release download $t -R aws/aws-emulator -p scores.json.gz -O raw/scores-$t.json.gz
  gunzip -kf raw/scores-$t.json.gz
done
python3 scripts/build_data.py v1.0.322 v1.0.293   # current, previous
python3 -m http.server -d site 8765
```

## Caveats

- Service scores count every unit that lists the service, so a cross-service test counts against each service it touches. The single-service score is shown alongside.
- Operation test counts are attributions: a multi-step test counts for every operation it calls, so a failure may come from a different step.
- Compare scores only within one test-suite version. AWS adds and retires tests between releases.

Independent project, not affiliated with AWS. The emulator and its evaluation suite are CC0.
