package com.verbatim.helper.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [NoteEntity::class, NoteContentEntity::class, ProfileEntity::class, ProgressEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class VerbatimDatabase : RoomDatabase() {
    abstract fun dao(): VerbatimDao

    companion object {
        @Volatile
        private var INSTANCE: VerbatimDatabase? = null

        fun get(context: Context): VerbatimDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    VerbatimDatabase::class.java,
                    "verbatim.db",
                ).fallbackToDestructiveMigration().build().also { INSTANCE = it }
            }
    }
}
