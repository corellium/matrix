# Corellium MATRIX

This action runs the Corellium MATRIX solution.

### Setup

This action requires the following repository secrets to be set up. For more information, see the GitHub's documentation for [Creating secrets for a repository](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions#creating-secrets-for-a-repository).

| Secret | Description |
| ------ | ------ |
| `CORELLIUM_API_TOKEN` | Corellium API token that can be created in our Web UI |
| `CORELLIUM_PROJECT` | Corellium project ID |

Create a workflow `.yml` file in your repository's `.github/workflows` directory. An example workflow can be found [here](#usage). For more information, see the GitHub's documentation for [Using workflows](https://docs.github.com/en/actions/using-workflows#creating-a-workflow-file).

### Usage

See [action.yml](https://github.com/corellium/matrix/blob/master/action.yml)

Here's an example of how to use this action in a workflow file:

```
name: Run Corellium MATRIX solution

on: [push]

jobs:
  corellium-matrix:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run bundle

      - name: Run MATRIX action
        id: corellium-matrix
        uses: ./
        env:
          PROJECT: ${{ secrets.CORELLIUM_PROJECT }}
          API_TOKEN: ${{ secrets.CORELLIUM_API_TOKEN }}
        with:
          deviceFlavor: 'iphone14p'
          deviceOS: '17.2'
          server: 'https://app.corellium.com'
          appPath: 'https://www.corellium.com/hubfs/Corellium_Cafe.ipa'
          userActions: '/test/user-actions.json'
          keywords: '/test/keywords.txt'

      - run: echo "${{ steps.corellium-matrix.outputs.report }}"

```

### Inputs

| Input | Description | Example | Required | Default |
| ------ | ------ | ------ | ------ | ------ |
| `server` | Specifies which Corellium server to use | <https://app.corellium.com> | false | <https://app.corellium.com> |
| `deviceFlavor` | The flavor of the Instance that is being created | `iphone14p` | true | n/a |
| `deviceOS` | The software version | `17.2` | true | n/a |
| `appPath` | URL to download test app or local path of the app relative to the Github workspace | <https://www.corellium.com/hubfs/Corellium_Cafe.ipa> | true | n/a |
| `userActions` | URL to download device input `.json` file or local path of the `.json` file relative to the Github workspace. Examples can be found [here](https://app.corellium.com/api/docs#post-/v1/instances/-instanceId-/input) | `/test/user-actions.json` | true | n/a |
| `keywords` | URL to download wordlist `.txt` file or local path of the `.txt` file relative to the Github workspace | `/test/keywords.txt` | false | n/a |

### Outputs

| Output | Description |
| ------ | ------ |
| `report` | MATRIX report artifact download path relative to the Github workspace |
