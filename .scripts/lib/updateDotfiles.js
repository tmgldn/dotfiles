const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const hasBin = require('./hasBin.js')
const Diff = require('./diff.js')
const { isText } = require('./isTextOrBinary.js')
const readline = require('node:readline');
const cp = require("node:child_process")
const { stdin: input, stdout: output } = require('node:process');

const prompt = (str) => {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output });
    rl.question(str, (answer) => {
      rl.close();
      resolve(answer);
    });
  })
}

const red = str => `\x1b[31m${str}\x1b[0m`
const green = str => `\x1b[32m${str}\x1b[0m`

;(async () => {
  const sections = ['all'];
  if (process.platform === 'darwin' || process.platform === 'linux') {
    sections.push(process.platform)
  }
  if (process.platform === 'linux') {
    if (hasBin("pacman")) {
      sections.push("pacman")
    } else if (hasBin("apt")) {
      sections.push("apt")
    }
  }

  const parts = sections.reduce((o, k) => {
    o[k] = new Set();
    return o;
  }, {});

  const references = new Map()

  const scanDir = async (currPath, set) => {
    const list = await fs.readdir(currPath, { withFileTypes: true })

    const promises = []

    for (const item of list) {
      if (item.isFile()) {
        set.add(path.join(currPath, item.name))
      } else if (item.isDirectory()) {
        promises.push(scanDir(path.join(currPath, item.name), set))
      }
    }

    await Promise.all(promises)
  }

  await Promise.all(
    Object.keys(parts)
      .map((part) => scanDir(path.join(__dirname, '..', 'src', part), parts[part]))
  )

  await Promise.all(
    (await fs.readdir(path.join(__dirname, '..', 'src', 'references'), {
      withFileTypes: true
    })).map((ref) => {
      if (ref.isDirectory()) {
        const set = new Set()
        references.set(ref.name, set)
        return scanDir(
          path.join(__dirname, '..', 'src', 'references', ref.name),
          set
        )
      }
    })
  )

  const mappings = []

  sections.forEach((section) => {
    const root = path.join(__dirname, '..', 'src', section)
    for (const file of parts[section]) {
      if (file.endsWith('.reference')) {
        const frags = file.split('/')
        const ref = frags[frags.length - 1].slice(0, -10)
        const refRoot = path.join(__dirname, '..', 'src', 'references', ref)
        for (const refFile of references.get(ref)) {
          mappings.push([
            refFile,
            path.join(os.homedir(), file.slice(root.length + 1, -(ref.length + 11)), refFile.slice(refRoot.length + 1))
          ])
        }
      } else {
        mappings.push([
          file,
          path.join(os.homedir(), file.slice(root.length + 1))
        ])
      }
    }
  })

  let hasChanges = false

  await Promise.all(mappings.map(async ([from, to]) => {
    let isFromFileText = null
    try {
      isFromFileText = isText(from)
    } catch (err) {}
    let isToFileText = null
    try {
      isToFileText = isText(to)
    } catch (err) {}

    // if file is not diffable, just replace the file
    if (!isFromFileText || !isToFileText) {
      try {
        await fs.unlink(to)
      } catch (err) {}
      try {
        cp.execSync(`mkdir -p "${path.join(to, '..')}"`)
        await fs.copyFile(from, to)
      } catch (err) {}
    } else {
      let toFileText = null
      try {
        toFileText = await fs.readFile(to, 'utf8')
      } catch (err) {}

      if (toFileText === null) {
        try {
          await fs.unlink(to)
        } catch (err) {}
        cp.execSync(`mkdir -p "${path.join(to, '..')}"`)
        await fs.copyFile(from, to)
      } else {
        const fromFileText = await fs.readFile(from, 'utf8')

        if (toFileText !== fromFileText) {
          console.log("Proposed changes to:", to)

          const diffs = Diff.diffLines(toFileText, fromFileText)
          // Iterate the new lines

          let str = ""
          for (const diff of diffs) {
            if (diff.added) {
              str += green(diff.value)
            } else if (diff.removed) {
              str += red(diff.value)
            } else {
              str += diff.value
            }
          }
          console.log(str)

          const choice = await new Promise(async (resolve) => {
            let response = null
            const validResponses = new Set("ukm".split(""))
            while (!validResponses.has(response)) {
              response = (await prompt('[U]pdate, [K]eep or [M]anual merge? ')).trim().toLowerCase();
            }
            resolve(response)
          })

          if (choice === "u") {
            try {
              await fs.unlink(to)
            } catch (err) {}
            await fs.copyFile(from, to)
          } else if (choice === "m") {
            let str = ""
            for (let i = 1; i < diffs.length; i++) {
              const a = diffs[i - 1]
              const b = diffs[i]
              const aType = a.added ? "a" : (a.removed ? "r" : "-")
              const bType = b.added ? "a" : (b.removed ? "r" : "-")
              const type = aType + bType

              if (type === "-a" || type === "-r") {
                str += a.value
              } else if (type === "a-") {
                str += `<<<<<<< ↓ LOCAL ↓\n=======\n${a.value}>>>>>>> ↑ REMOTE ↑\n`
              } else if (type === "r-") {
                str += `<<<<<<< ↓ LOCAL ↓\n${a.value}=======\n>>>>>>> ↑ REMOTE ↑\n`
              } else { // "ra"
                str += `<<<<<<< ↓ LOCAL ↓\n${a.value}=======\n${b.value}>>>>>>> ↑ REMOTE ↑\n`
                i++
              }
            }
            if (diffs.length > 0) {
              const diff = diffs[diffs.length - 1]
              if (diff.added) {
                str += `<<<<<<< ↓ LOCAL ↓\n=======\n${diff.value}>>>>>>> ↑ REMOTE ↑\n`
              } else if (diff.removed) {
                str += `<<<<<<< ↓ LOCAL ↓\n${diff.value}=======\n>>>>>>> ↑ REMOTE ↑\n`
              } else {
                str += diff.value
              }
            }

            let ext = to.match(/\.([a-zA-Z0-9]+)$/)
            ext = ext === null ? "" : ext[0]
            const filePath = path.join(os.tmpdir(), `${Math.random().toString().slice(2)}${ext}`)
            await fs.writeFile(filePath, str)
            cp.execSync(`${process.platform === "linux" ? "code" : "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"} '${filePath}'`)

            await prompt('Opened editor. Edit and save, then press [Enter] to continue')

            try {
              await fs.unlink(to)
            } catch (err) {}
            await fs.copyFile(filePath, to)
          }

          if (choice !== "u") {
            const remoteResult = fs.readFile(from, 'utf8')
            const newResult = fs.readFile(to, 'utf8')
            if (remoteResult !== newResult) {
              try {
                await fs.unlink(from)
              } catch (err) {}
              await fs.copyFile(to, from)
              hasChanges = true;
            }
          }
        }
      }
    }
  }))

  if (hasChanges) {
    console.log('changes made locally but not updated elsewhere')
    // cp.execSync(`zsh -c 'git --git-dir=$HOME/.dotfiles --work-tree=$HOME add $HOME/.scripts $HOME/README.md; git --git-dir=$HOME/.dotfiles --work-tree=$HOME commit -m "updateDotfiles.js"; git --git-dir=$HOME/.dotfiles --work-tree=$HOME push --set-upstream origin main'`)
  }
})()

