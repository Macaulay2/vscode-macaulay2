needsPackage "Style"

generateGrammar("syntaxes/macaulay2.tmLanguage.json", demark_"|")
generateGrammar("src/backend/completionProviders.ts",x -> demark(", ", format \ x))
