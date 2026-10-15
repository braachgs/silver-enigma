// Day Board's Android home-screen widget. The core build holds everything
// that doesn't need Android (and is tested on its own); app is the widget.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "dayboard-android"
includeBuild("core")
include(":app")
